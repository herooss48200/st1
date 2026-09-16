import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import config from '../src/config/config.js';
import {
  buildHistoricalReplayRecord,
  confirmHistoricalSetup,
  createReplayCohortReport,
  findHistoricalRenkoSetups,
  resolveHistoricalReplayPeriodEnd,
  resolveHistoricalReplayRunHash
} from '../src/research/st1-historical-replay.js';
import { createDeterministicConfigHash } from '../src/research/st1-scientific-shadow.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MINUTE_MS = 60_000;
const FIFTEEN_MINUTE_MS = 15 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CACHE_VERSION = 1;

const integerEnv = (name, fallback, minimum = 1) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
};

const numberEnv = (name, fallback, minimum = 0) => {
  const value = Number.parseFloat(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
};

const settings = {
  days: integerEnv('R432_REPLAY_DAYS', 90),
  topCoins: integerEnv('R432_REPLAY_TOP_COINS', Number(config.TOP_COINS_COUNT || 300)),
  candleLimit: integerEnv('R432_REPLAY_CANDLE_LIMIT', Number(config.ST1_RENKO_CANDLE_LIMIT || 800), 32),
  requestDelayMs: integerEnv('R432_REPLAY_REQUEST_DELAY_MS', 200, 100),
  workerConcurrency: Math.min(4, integerEnv('R432_REPLAY_CONCURRENCY', 3)),
  maximumWaitMinutes: integerEnv('R432_REPLAY_MAX_WAIT_MINUTES', 15),
  cooldownMinutes: integerEnv('R432_REPLAY_SYMBOL_COOLDOWN_MINUTES', 240),
  mainHorizonMinutes: integerEnv('R432_REPLAY_MAIN_HORIZON_MINUTES', 240),
  horizonsMinutes: [15, 30, 45, 60, 120, 240],
  notionalUsdt: numberEnv('R432_REPLAY_NOTIONAL_USDT', Number(config.TRADE_SIZE_USDT || 50), 1),
  commissionPercent: Number(config.COMMISSION_RATE || 0.0004) * 2 * 100,
  slippagePercent: Number(config.ESTIMATED_SLIPPAGE_PERCENT || 0.05),
  orderFlow: {
    windowCandles: Number(config.ST1_ORDERFLOW_WINDOW_CANDLES || 3),
    requiredConfirmations: Number(config.ST1_ORDERFLOW_REQUIRED_CONFIRMATIONS || 2),
    confirmationTimeoutMinutes: Number(config.ST1_ORDERFLOW_CONFIRM_TIMEOUT_MINUTES || 3),
    longMinimumBuyRatio: Number(config.ST1_ORDERFLOW_LONG_MIN_BUY_RATIO || 0.58),
    shortMaximumBuyRatio: Number(config.ST1_ORDERFLOW_SHORT_MAX_BUY_RATIO || 0.42),
    maxChaseT: Number(config.ST1_RENKO_MAX_CHASE_T || 0.25)
  },
  candidates: {
    oversold: Number(config.ST1_RENKO_RSI_OVERSOLD || 30),
    overbought: Number(config.ST1_RENKO_RSI_OVERBOUGHT || 70),
    rsiProximityPoints: Number(config.ST1_SHADOW_RSI_PROXIMITY_POINTS || 2),
    longFlowMinimum: Number(config.ST1_ORDERFLOW_LONG_MIN_BUY_RATIO || 0.58),
    longFlowMaximum: Number(config.ST1_SHADOW_LONG_FLOW_MAX_BUY_RATIO || 0.72)
  }
};
settings.roundTripCostPercent = settings.commissionPercent + settings.slippagePercent;
const ANALYSIS_END_TIME = resolveHistoricalReplayPeriodEnd(process.env.R432_REPLAY_PERIOD_END_UTC);
const ANALYSIS_START_TIME = (ANALYSIS_END_TIME + 1) - (settings.days * DAY_MS);
const WARMUP_START_TIME = ANALYSIS_START_TIME - (settings.candleLimit * FIFTEEN_MINUTE_MS);
const SPLIT_TIME = ANALYSIS_START_TIME + ((ANALYSIS_END_TIME - ANALYSIS_START_TIME) * (2 / 3));
settings.periodEndTime = ANALYSIS_END_TIME;
const runHashOverride = resolveHistoricalReplayRunHash(process.env.R432_REPLAY_RUN_HASH);
const scientificSettings = { ...settings };
delete scientificSettings.requestDelayMs;
delete scientificSettings.workerConcurrency;
settings.runHash = runHashOverride || createDeterministicConfigHash(scientificSettings).slice(0, 16);

const outputDirectory = path.join(process.cwd(), 'data', 'research');
const cacheDirectory = path.join(outputDirectory, 'r432-cache');
const checkpointPath = path.join(outputDirectory, `r432-replay-${settings.runHash}.partial.json`);
const latestJsonPath = path.join(outputDirectory, 'r432-historical-replay-latest.json');
const latestMarkdownPath = path.join(outputDirectory, 'r432-historical-replay-latest.md');
const baseUrl = config.getBinanceUrl();
let lastRequestAt = 0;
let requestSlotQueue = Promise.resolve();
let checkpointWriteQueue = Promise.resolve();

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temporaryPath, content);
  await fs.rename(temporaryPath, filePath);
}

async function reserveRequestSlot() {
  const slot = requestSlotQueue.then(async () => {
    const delay = Math.max(0, settings.requestDelayMs - (Date.now() - lastRequestAt));
    if (delay > 0) await wait(delay);
    lastRequestAt = Date.now();
  });
  requestSlotQueue = slot.catch(() => {});
  await slot;
}

async function request(pathname, params = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await reserveRequestSlot();
    try {
      const response = await axios.get(`${baseUrl}${pathname}`, {
        params,
        timeout: 30_000,
        validateStatus: (status) => status >= 200 && status < 300
      });
      return response.data;
    } catch (error) {
      lastError = error;
      const status = Number(error.response?.status || 0);
      if (![418, 429].includes(status) && status < 500) break;
      const retryAfterSeconds = Number(error.response?.headers?.['retry-after']);
      const backoff = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : Math.min(60_000, 1_000 * (2 ** (attempt - 1)));
      await wait(backoff);
    }
  }
  throw lastError;
}

function parseKlines(rows, symbol) {
  return (Array.isArray(rows) ? rows : []).map((candle) => ({
    symbol,
    openTime: Number(candle[0]),
    closeTime: Number(candle[6]),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5]),
    quoteVolume: Number(candle[7]),
    trades: Number(candle[8]),
    takerBuyVolume: Number(candle[9]),
    takerBuyQuoteVolume: Number(candle[10])
  })).filter((candle) => Number.isFinite(candle.openTime) && Number.isFinite(candle.closeTime));
}

async function fetchKlineRange(symbol, interval, startTime, endTime) {
  const intervalMs = interval === '1m' ? MINUTE_MS : FIFTEEN_MINUTE_MS;
  const map = new Map();
  let cursor = Math.max(0, Number(startTime));

  while (cursor <= endTime) {
    const rows = await request('/fapi/v1/klines', {
      symbol,
      interval,
      startTime: cursor,
      endTime,
      limit: 1500
    });
    const parsed = parseKlines(rows, symbol);
    if (!parsed.length) break;
    for (const candle of parsed) {
      if (candle.openTime >= startTime && candle.closeTime <= endTime) map.set(candle.openTime, candle);
    }
    const nextCursor = Number(parsed.at(-1).openTime) + intervalMs;
    if (!(nextCursor > cursor)) break;
    cursor = nextCursor;
    if (parsed.length < 1500) break;
  }

  return [...map.values()].sort((left, right) => left.openTime - right.openTime);
}

async function readGzipJson(filePath) {
  try {
    return JSON.parse((await gunzipAsync(await fs.readFile(filePath))).toString('utf8'));
  } catch {
    return null;
  }
}

async function writeGzipJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, await gzipAsync(Buffer.from(JSON.stringify(value))));
}

async function fetchCachedFifteenMinuteCandles(symbol, warmupStartTime, analysisEndTime) {
  const cachePath = path.join(cacheDirectory, `${symbol}-15m-${settings.runHash}.json.gz`);
  const cached = await readGzipJson(cachePath);
  if (cached?.version === CACHE_VERSION
    && cached.startTime === warmupStartTime
    && cached.endTime === analysisEndTime
    && Array.isArray(cached.candles)) {
    return cached.candles;
  }
  const candles = await fetchKlineRange(symbol, '15m', warmupStartTime, analysisEndTime);
  await writeGzipJson(cachePath, {
    version: CACHE_VERSION,
    symbol,
    startTime: warmupStartTime,
    endTime: analysisEndTime,
    candles
  });
  return candles;
}

function mergeTimeRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => left.startTime - right.startTime);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startTime <= previous.endTime + MINUTE_MS) {
      previous.endTime = Math.max(previous.endTime, range.endTime);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

async function fetchOneMinuteWindows(symbol, setups, analysisEndTime) {
  const maximumForwardMinutes = settings.maximumWaitMinutes + Math.max(...settings.horizonsMinutes) + 2;
  const ranges = mergeTimeRanges(setups.map((setup) => ({
    startTime: Math.max(0, Number(setup.evaluatedAt) - (5 * MINUTE_MS)),
    endTime: Math.min(analysisEndTime, Number(setup.evaluatedAt) + (maximumForwardMinutes * MINUTE_MS))
  })));
  const map = new Map();
  for (const range of ranges) {
    const candles = await fetchKlineRange(symbol, '1m', range.startTime, range.endTime);
    for (const candle of candles) map.set(candle.openTime, candle);
  }
  return [...map.values()].sort((left, right) => left.openTime - right.openTime);
}

function getSetupMinuteWindow(candles, setup) {
  const start = Number(setup.evaluatedAt) - (5 * MINUTE_MS);
  const end = Number(setup.evaluatedAt)
    + ((settings.maximumWaitMinutes + Math.max(...settings.horizonsMinutes) + 2) * MINUTE_MS);
  return candles.filter((candle) => Number(candle.closeTime) >= start && Number(candle.closeTime) <= end);
}

async function getUniverse() {
  const tickers = await request('/fapi/v1/ticker/24hr');
  return (Array.isArray(tickers) ? tickers : [])
    .filter((ticker) => String(ticker?.symbol || '').endsWith('USDT'))
    .filter((ticker) => String(ticker.symbol) !== String(config.BTC_SYMBOL || 'BTCUSDT'))
    .filter((ticker) => !config.EXCLUDED_ENTRY_SYMBOLS.has(String(ticker.symbol).toUpperCase()))
    .map((ticker) => ({ symbol: String(ticker.symbol), quoteVolume: Number(ticker.quoteVolume || 0) }))
    .sort((left, right) => right.quoteVolume - left.quoteVolume)
    .slice(0, settings.topCoins)
    .map((ticker) => ticker.symbol);
}

async function loadCheckpoint() {
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    return checkpoint?.runHash === settings.runHash
      ? checkpoint
      : { runHash: settings.runHash, completedSymbols: [], records: [], failures: [] };
  } catch {
    return { runHash: settings.runHash, completedSymbols: [], records: [], failures: [] };
  }
}

async function saveCheckpoint(checkpoint) {
  const snapshot = JSON.stringify(checkpoint, null, 2);
  const write = checkpointWriteQueue.then(() => atomicWrite(checkpointPath, snapshot));
  checkpointWriteQueue = write.catch(() => {});
  await write;
}

const formatNumber = (value, digits = 4) => value === 'INF'
  ? 'INF'
  : (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-');

function markdownTable(summary) {
  const labels = {
    baseline: 'BASELINE',
    longBaseline: 'LONG BASELINE',
    shortBaseline: 'SHORT BASELINE',
    rsiNear: 'RSI NEAR',
    longFlowBand: 'LONG FLOW 0.58-0.72',
    longRsiFlow: 'LONG RSI+FLOW',
    shortRsiNear: 'SHORT RSI 70-72'
  };
  const rows = Object.entries(summary).map(([name, item]) => {
    const checks = item.promotionChecks;
    const passed = Object.values(checks).every(Boolean) ? 'PASS' : 'WAIT';
    return `| ${labels[name]} | ${item.trades} | ${item.wins}/${item.losses}/${item.breakEven} | ${formatNumber(item.netPnlUsdt)} | ${formatNumber(item.profitFactor)} | ${formatNumber(item.firstHalfNetPnlUsdt)} | ${formatNumber(item.secondHalfNetPnlUsdt)} | ${formatNumber(item.bestTradeRemovedNetPnlUsdt)} | ${passed} |`;
  });
  return [
    '| Kohort | N | W/L/BE | Net USDT | PF | İlk yarı | İkinci yarı | En iyi çıkarılınca | Karar |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows
  ].join('\n');
}

function createMarkdownReport(result) {
  return `# ST1 R43.2 — 90 Günlük Tarihsel Giriş Replay\n\n` +
    `- Oluşturulma: ${result.generatedAt}\n` +
    `- Dönem: ${new Date(result.period.startTime).toISOString()} — ${new Date(result.period.endTime).toISOString()}\n` +
    `- Geliştirme / OOS ayrımı: ${new Date(result.period.splitTime).toISOString()}\n` +
    `- Evren: güncel hacme göre ${result.universe.length} USDT-M sembol\n` +
    `- Renko pencere uzunluğu: ${settings.candleLimit} adet 15m mum\n` +
    `- Ana sonuç ufku: ${settings.mainHorizonMinutes} dakika\n` +
    `- Maliyet: %${formatNumber(settings.roundTripCostPercent, 4)} (${formatNumber(settings.notionalUsdt, 2)} USDT notional)\n\n` +
    `## Tüm dönem\n\n${markdownTable(result.cohorts.all)}\n\n` +
    `## Geliştirme dönemi — ilk üçte iki\n\n${markdownTable(result.cohorts.development)}\n\n` +
    `## Dokunulmamış doğrulama dönemi — son üçte bir\n\n${markdownTable(result.cohorts.outOfSample)}\n\n` +
    `## Bilimsel sınırlar\n\n` +
    `- Giriş sinyali ve iki order-flow onayı üretim koduyla aynı fonksiyonlardan hesaplandı.\n` +
    `- Sonuçlar aktif stop/trailing replay'i değildir; sabit ileriye dönük fiyat ufuklarıdır. Bu nedenle giriş filtresinin bağımsız yön avantajını ölçer.\n` +
    `- Güncel en yüksek hacimli evren kullanıldığı için delist ve survivorship bias tamamen giderilemez.\n` +
    `- Bir kohort ancak N>=30, PF>=1.25, iki yarı pozitif ve en iyi işlem çıkarılınca pozitifse PASS olur.\n`;
}

async function main() {
  await fs.mkdir(outputDirectory, { recursive: true });
  const checkpoint = await loadCheckpoint();
  const universe = Array.isArray(checkpoint.universe) && checkpoint.universe.length
    ? checkpoint.universe
    : await getUniverse();
  checkpoint.universe = universe;
  const completed = new Set(checkpoint.completedSymbols);

  console.log(
    `R43.2 historical replay | ${settings.days} gün | ${universe.length} sembol | ` +
    `${settings.workerConcurrency} worker | bitiş ${new Date(ANALYSIS_END_TIME).toISOString()} | hash ${settings.runHash}`
  );
  const pendingJobs = [];
  for (let index = 0; index < universe.length; index += 1) {
    const symbol = universe[index];
    if (completed.has(symbol)) {
      console.log(`[${index + 1}/${universe.length}] ${symbol} resume: tamamlandı`);
      continue;
    }

    pendingJobs.push({ index, symbol });
  }

  let nextJobIndex = 0;
  const runWorker = async () => {
    while (nextJobIndex < pendingJobs.length) {
      const job = pendingJobs[nextJobIndex];
      nextJobIndex += 1;
      const { index, symbol } = job;

      try {
        const candles15m = await fetchCachedFifteenMinuteCandles(symbol, WARMUP_START_TIME, ANALYSIS_END_TIME);
        const setups = findHistoricalRenkoSetups(candles15m, {
          candleLimit: settings.candleLimit,
          analysisStartTime: ANALYSIS_START_TIME,
          sourceInterval: '15m',
          atrPeriod: Number(config.ST1_RENKO_ATR_PERIOD),
          bollingerPeriod: Number(config.ST1_RENKO_BOLLINGER_PERIOD),
          bollingerStdDev: Number(config.ST1_RENKO_BOLLINGER_STD_DEV),
          bandToleranceT: Number(config.ST1_RENKO_BB_TOUCH_TOLERANCE_T),
          rsiPeriod: Number(config.ST1_RENKO_RSI_PERIOD),
          rsiMaximum: Number(config.ST1_RENKO_RSI_OVERSOLD),
          rsiMinimum: Number(config.ST1_RENKO_RSI_OVERBOUGHT),
          entryOffsetT: Number(config.ST1_RENKO_ENTRY_OFFSET_T),
          maxBricks: Number(config.ST1_RENKO_MAX_BRICKS)
        });
        const candles1m = setups.length
          ? await fetchOneMinuteWindows(symbol, setups, ANALYSIS_END_TIME)
          : [];
        let confirmedCount = 0;
        let lastAcceptedEntryTime = Number.NEGATIVE_INFINITY;

        for (const setup of setups) {
          const minuteWindow = getSetupMinuteWindow(candles1m, setup);
          const confirmation = confirmHistoricalSetup(setup, minuteWindow, {
            ...settings.orderFlow,
            maximumWaitMinutes: settings.maximumWaitMinutes
          });
          if (!confirmation.confirmed) continue;
          if (confirmation.entryTime - lastAcceptedEntryTime < settings.cooldownMinutes * MINUTE_MS) continue;

          checkpoint.records.push(buildHistoricalReplayRecord({
            symbol,
            setup,
            confirmation,
            oneMinuteCandles: minuteWindow,
            horizonsMinutes: settings.horizonsMinutes,
            roundTripCostPercent: settings.roundTripCostPercent,
            notionalUsdt: settings.notionalUsdt,
            candidateSettings: settings.candidates
          }));
          lastAcceptedEntryTime = confirmation.entryTime;
          confirmedCount += 1;
        }

        checkpoint.completedSymbols.push(symbol);
        completed.add(symbol);
        await saveCheckpoint(checkpoint);
        console.log(`[${index + 1}/${universe.length}] ${symbol} | 15m=${candles15m.length} | pusu=${setups.length} | giriş=${confirmedCount}`);
      } catch (error) {
        checkpoint.failures.push({ symbol, at: Date.now(), error: error.message });
        await saveCheckpoint(checkpoint);
        console.error(`[${index + 1}/${universe.length}] ${symbol} HATA: ${error.message}`);
      }
    }
  };

  const workerCount = Math.min(settings.workerConcurrency, pendingJobs.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  await checkpointWriteQueue;

  const universeOrder = new Map(universe.map((symbol, index) => [symbol, index]));
  const completedSymbols = [...new Set(checkpoint.completedSymbols)]
    .sort((left, right) => universeOrder.get(left) - universeOrder.get(right));
  const records = [...checkpoint.records].sort((left, right) => (
    Number(left.entryTime) - Number(right.entryTime)
    || String(left.symbol).localeCompare(String(right.symbol))
  ));

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion: config.APP_VERSION,
    runHash: settings.runHash,
    methodology: 'PRODUCTION_ENTRY_REPLAY_WITH_FIXED_FORWARD_RETURN_HORIZONS',
    settings,
    period: { startTime: ANALYSIS_START_TIME, splitTime: SPLIT_TIME, endTime: ANALYSIS_END_TIME },
    universe,
    checkpointHashOverrideUsed: Boolean(runHashOverride),
    completedSymbols,
    failures: checkpoint.failures,
    records,
    cohorts: createReplayCohortReport(records, {
      horizonMinutes: settings.mainHorizonMinutes,
      splitTime: SPLIT_TIME
    })
  };

  await atomicWrite(latestJsonPath, JSON.stringify(result, null, 2));
  await atomicWrite(latestMarkdownPath, createMarkdownReport(result));
  console.log(`\nTamamlandı: ${latestMarkdownPath}`);
  console.log(`Ham sonuç: ${latestJsonPath}`);
}

main().catch((error) => {
  console.error('R43.2 historical replay failed:', error);
  process.exitCode = 1;
});
