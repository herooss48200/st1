import logger from './services/logger.js';
import NotificationService from './services/notification-service.js';
import TradeSnapshotService from './statistics/trade-snapshot-service.js';
import { ORDER_STATUS, ORDER_TYPE, TREND_TYPE } from './shared/types/index.js';
import config from './config/config.js';
import { MarketBreadthService } from './services/market-breadth-service.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyEconomicOutcome, selectFilledProtectiveOrder } from './utils/close-truth.js';
import St1RescueRadar from './services/st1-rescue-radar.js';

const STRATEGY_CANDLE_INTERVAL_MS = config.STRATEGY_CANDLE_INTERVAL_MS;
const BTC_SYMBOL = config.BTC_SYMBOL;
const DEFAULT_SIMILARITY_INTERVAL = config.SIMILARITY_INTERVAL;
const DEFAULT_TOP_COINS_COUNT = config.TOP_COINS_COUNT;
const DEFAULT_SIMILARITY_THRESHOLD = config.SIMILARITY_THRESHOLD;
const DEFAULT_ATR_PERIOD = config.ATR_PERIOD;
const DEFAULT_READY_TRIGGER_INTERVAL = config.READY_BOLLINGER_INTERVAL;
const ONE_MIN_CONFIRM_INTERVAL = config.TRIGGER_INTERVAL;
const DEFAULT_INITIAL_TP_PERCENT = config.INITIAL_TP_PERCENT;
const DEFAULT_INITIAL_SL_PERCENT = config.STOP_LOSS_PERCENT;
const DEFAULT_BREAK_EVEN_TRIGGER_PERCENT = config.BREAK_EVEN_TRIGGER_PERCENT;
const DEFAULT_TRAILING_ATR_MULTIPLIER = config.TRAILING_ATR_MULTIPLIER;
const DEFAULT_TRAILING_ACTIVATION_ATR_MULTIPLIER = config.TRAILING_ACTIVATION_ATR_MULTIPLIER;
const DEFAULT_BE_ATR_MULTIPLIER = config.BE_ATR_MULTIPLIER;
const DEFAULT_TP_STEP_ATR_MULTIPLIER = config.TP_STEP_ATR_MULTIPLIER;
const DEFAULT_MIN_TP_STEP_PERCENT = config.MIN_TP_STEP_PERCENT;
const DEFAULT_POSITION_FOLLOW_MODE = config.POSITION_FOLLOW_MODE;
const DEFAULT_AMBUSH_TIMEOUT_MINUTES = config.AMBUSH_TIMEOUT_MINUTES;
const DEFAULT_AMBUSH_REFRESH_INTERVAL_MINUTES = config.AMBUSH_REFRESH_INTERVAL_MINUTES;
const DEFAULT_AMBUSH_MONITOR_INTERVAL_MS = config.AMBUSH_MONITOR_INTERVAL_MS;
const DEFAULT_POSITION_MONITOR_INTERVAL_MS = config.POSITION_MONITOR_INTERVAL_MS;
const DEFAULT_MAX_POSITIONS = config.MAX_POSITIONS;
const PROTECTION_RETRY_DELAYS_MS = config.PROTECTION_RETRY_DELAYS_MS;
const PROTECTION_EMERGENCY_CLOSE_MAX_FAILURES = config.PROTECTION_EMERGENCY_CLOSE_MAX_FAILURES;
const EPSILON = 1e-12;

export function hasRequiredConfirmations(conditions, requiredCount = config.REQUIRED_CONFIRMATION_COUNT) {
  return conditions.filter(Boolean).length >= requiredCount;
}

export function preserveAmbushRuntimeState(nextAmbush, previousAmbush) {
  const canPreserveReady =
    previousAmbush?.ready === true &&
    previousAmbush.triggered !== true &&
    previousAmbush.expectedSignal === nextAmbush.expectedSignal;

  if (!canPreserveReady) {
    return nextAmbush;
  }

  return {
    ...nextAmbush,
    addedAt: previousAmbush.addedAt,
    ready: true,
    readyAt: previousAmbush.readyAt,
    readyReason: previousAmbush.readyReason,
    ...(previousAmbush.readyRegime != null
      ? { readyRegime: previousAmbush.readyRegime }
      : {}),
    ...(previousAmbush.st1Setup != null
      ? { st1Setup: previousAmbush.st1Setup }
      : {}),
    ...(previousAmbush.st1LastFilterReason != null
      ? { st1LastFilterReason: previousAmbush.st1LastFilterReason }
      : {})
  };
}

export class TradingLoop {
  constructor(services, engines) {
    this.candleService = services.candleService;
    this.marketData = services.marketData;
    this.historicalCandleCache = services.historicalCandleCache;
    this.orderService = services.orderService;
    this.marketBreadth = services.marketBreadth || new MarketBreadthService(this.marketData);

    this.similarity = engines.similarity;
    this.trend = engines.trend;
    this.trigger = engines.trigger;
    this.riskManager = engines.riskManager;

    this.st1RescueRadar = new St1RescueRadar({
      enabled: config.ST1_RESCUE_RADAR_ENABLED,
      protectLongs: true,
      protectShorts: true,
      supertrendPeriod: config.FINAL_SUPERTREND_PERIOD,
      supertrendMultiplier: config.FINAL_SUPERTREND_MULTIPLIER,
      emaFastPeriod: config.BTC_TREND_EMA_FAST_PERIOD,
      emaSlowPeriod: config.BTC_TREND_EMA_SLOW_PERIOD,
      bollingerPeriod: config.BOLLINGER_PERIOD,
      bollingerStdDev: config.BOLLINGER_STD_DEV,
      st1BbTolerancePercent: config.ST1_RESCUE_RADAR_ST1_BB_TOLERANCE_PERCENT,
      st1RecentMinutes: config.ST1_RESCUE_RADAR_ST1_RECENT_MINUTES,
      yellowBtc5BbPercentB: config.ST1_RESCUE_RADAR_YELLOW_BTC5_BB_PERCENT_B,
      yellowBtc15Ema50DistancePercent: config.ST1_RESCUE_RADAR_YELLOW_BTC15_EMA50_DISTANCE_PERCENT,
      orangeFastDrop5mPercent: -Math.abs(config.ST1_RESCUE_RADAR_ORANGE_FAST_MOVE_5M_PERCENT),
      fastRedDrop5mPercent: -Math.abs(config.ST1_RESCUE_RADAR_FAST_RED_MOVE_5M_PERCENT),
      fastRedMinPositions: config.ST1_RESCUE_RADAR_FAST_RED_MIN_POSITIONS,
      fastRedNegativeRatio: config.ST1_RESCUE_RADAR_FAST_RED_NEGATIVE_RATIO,
      fastRedPnlDelta3mUsdt: config.ST1_RESCUE_RADAR_FAST_RED_PNL_DELTA_3M_USDT,
      slowRedDrop10mPercent: -Math.abs(config.ST1_RESCUE_RADAR_SLOW_RED_MOVE_10M_PERCENT),
      slowRedMinPositions: config.ST1_RESCUE_RADAR_SLOW_RED_MIN_POSITIONS,
      slowRedNegativeRatio: config.ST1_RESCUE_RADAR_SLOW_RED_NEGATIVE_RATIO,
      slowRedBtc15Ema50MinDistancePercent: config.ST1_RESCUE_RADAR_SLOW_RED_BTC15_EMA50_MIN_DISTANCE_PERCENT,
      directionFlipMinPositions: config.ST1_RESCUE_RADAR_DIRECTION_FLIP_MIN_POSITIONS,
      directionFlipNegativeRatio: config.ST1_RESCUE_RADAR_DIRECTION_FLIP_NEGATIVE_RATIO,
      recoveryConfirmMs: config.ST1_RESCUE_RADAR_RECOVERY_CONFIRM_MS
    });
    this.st1RescueCloseInProgress = false;
    this.entryFunnelWindow = this.createEntryFunnelWindow();

    this.ambushList = new Map();
    this.activePositions = new Map();
    this.tradeStats = {
      total: 0,
      openedTotal: 0,
      successful: 0,
      failed: 0,
      neutral: 0,
      breakEven: 0,
      tp: 0,
      sl: 0,
      external: 0,
      tpLong: 0,
      tpShort: 0,
      trailLong: 0,
      trailShort: 0,
      slLong: 0,
      slShort: 0,
      beLong: 0,
      beShort: 0,
      externalLong: 0,
      externalShort: 0
    };
    this.closedTradeHistory = [];
    this.riskTradeHistory = [];
    this.paperWalletStartUsdt = parseFloat(
      process.env.PAPER_WALLET_START_USDT || String(config.PAPER_WALLET_START_USDT)
    );
    this.paperWalletBalanceUsdt = this.paperWalletStartUsdt;
    this.realizedPnlForTradeSizeUsdt = 0;
    this.totalCommissionUsdt = 0;
    this.commissionRate = parseFloat(process.env.COMMISSION_RATE || '0.0004');
    this.lastAmbushRefreshAt = null;
    this.running = false;
    this.strategyLoopHandle = null;
    this.ambushMonitorLoopHandle = null;
    this.positionLoopHandle = null;
    this.isStrategyCycleRunning = false;
    this.isAmbushMonitorCycleRunning = false;
    this.isPositionCycleRunning = false;
    this.positionOwnershipWarnings = new Map();
    this.protectionFailureCounts = new Map();
    this.performanceReportLoopHandle = null;
    this.startedAt = null;
    this.sessionId = String(process.env.BOT_SESSION_ID || randomUUID());
    this.sessionStartedAt = Date.now();
    // ST1 session counters reset on every process start; all-time ledger remains persistent.
    this.sessionStats = {
      openedTotal: 0,
      total: 0,
      successful: 0,
      failed: 0,
      neutral: 0,
      netPnlUsdt: 0
    };
    this.lastAmbushScanResult = null;
    this.accountingStartedAt = Date.now();
    this.accountingStartWalletUsdt = null;
    this.restoreAccountingState();
  }

  getSessionStatsSnapshot() {
    return { ...this.sessionStats };
  }

  isSt1RescueRadarRuntimeEnabled() {
    return config.ST1_RESCUE_RADAR_ENABLED === true
      && (String(process.env.NODE_ENV || '').toLowerCase() !== 'test'
        || process.env.ALLOW_TEST_RESCUE_RADAR === 'true');
  }

  createEntryFunnelWindow() {
    const makeSide = () => ({
      setup: new Set(), bodyBreak: new Set(), coinDirection: new Set(), trendGuard: new Set(),
      breadth: new Set(), risk: new Set(), opened: new Set()
    });
    return { startedAt: Date.now(), LONG: makeSide(), SHORT: makeSide(), rejections: new Map() };
  }

  normalizeEntryFunnelSide(signal) {
    return String(signal || '').toUpperCase() === 'SELL' ? 'SHORT' : 'LONG';
  }

  markEntryFunnelStage(signal, stage, coin) {
    if (!config.ST1_ENTRY_FUNNEL_RADAR_ENABLED || !coin) return;
    const side = this.normalizeEntryFunnelSide(signal);
    const bucket = this.entryFunnelWindow?.[side]?.[stage];
    if (bucket instanceof Set) bucket.add(String(coin).toUpperCase());
  }

  markEntryFunnelRejection(signal, coin, reason) {
    if (!config.ST1_ENTRY_FUNNEL_RADAR_ENABLED || !coin || !reason) return;
    const side = this.normalizeEntryFunnelSide(signal);
    const key = `${side}:${String(coin).toUpperCase()}`;
    this.entryFunnelWindow.rejections.set(key, {
      coin: String(coin).toUpperCase(), side, reason: String(reason), at: Date.now()
    });
  }

  getEntryFunnelSnapshot({ reset = false } = {}) {
    const counts = {};
    for (const side of ['LONG', 'SHORT']) {
      counts[side] = {};
      const src = this.entryFunnelWindow?.[side] || {};
      for (const stage of ['setup', 'bodyBreak', 'coinDirection', 'trendGuard', 'breadth', 'risk', 'opened']) {
        counts[side][stage] = src[stage] instanceof Set ? src[stage].size : 0;
      }
    }
    const ambush = this.getAmbushDirectionCounts();
    const snapshot = {
      startedAt: this.entryFunnelWindow?.startedAt || Date.now(), endedAt: Date.now(),
      pusu: { LONG: ambush.longCount || 0, SHORT: ambush.shortCount || 0 },
      ...counts,
      recentRejections: [...(this.entryFunnelWindow?.rejections?.values?.() || [])]
        .sort((a, b) => b.at - a.at).slice(0, 6)
    };
    if (reset) this.entryFunnelWindow = this.createEntryFunnelWindow();
    return snapshot;
  }

  async loadSt1RescueRadarFrames() {
    const limit = Math.max(210, Number(config.ST1_RESCUE_RADAR_CANDLE_LIMIT || 220));
    const frames = {};
    await Promise.all(['1m', '3m', '5m', '15m'].map(async (interval) => {
      frames[interval] = this.historicalCandleCache
        ? await this.historicalCandleCache.getOrFetchCandles(BTC_SYMBOL, interval, limit)
        : await this.marketData.getKlines(BTC_SYMBOL, interval, limit);
    }));
    return frames;
  }

  buildPaperRescueRadarPositions(signal = 'BUY') {
    const normalized = signal === 'SELL' ? 'SELL' : 'BUY';
    const result = [];
    for (const [symbol, position] of this.activePositions) {
      if (!this.isPositionBotManaged(position) || position.signal !== normalized) continue;
      const markPrice = Number(position.lastMonitoredPrice || position.entryPrice);
      const entryPrice = Number(position.entryPrice);
      const notional = Number(position.executedNotionalUsdt ?? position.tradeSizeUsdt ?? 0);
      if (!(entryPrice > 0) || !(markPrice > 0)) continue;
      const moveRatio = normalized === 'BUY'
        ? (markPrice - entryPrice) / entryPrice
        : (entryPrice - markPrice) / entryPrice;
      result.push({ symbol, side: normalized, entryPrice, markPrice, quantity: Number(position.quantity || 0), unrealizedProfit: notional * moveRatio });
    }
    return result;
  }

  async evaluateSt1RescueRadar() {
    if (!this.isSt1RescueRadarRuntimeEnabled()) return null;
    const now = Date.now();
    const [frames, btcPrice] = await Promise.all([
      this.loadSt1RescueRadarFrames(),
      typeof this.orderService?.getCurrentPrice === 'function'
        ? this.orderService.getCurrentPrice(BTC_SYMBOL).catch(() => null)
        : Promise.resolve(null)
    ]);
    return this.st1RescueRadar.evaluate({
      now, frames, btcPrice,
      breadthState: this.marketBreadth?.current?.breadth15m?.state || 'MISSING',
      managedLongs: this.buildPaperRescueRadarPositions('BUY'),
      managedShorts: this.buildPaperRescueRadarPositions('SELL')
    });
  }

  async emergencyClosePaperPositionsForRescueRadar(radarResult) {
    const isPaper = String(process.env.APP_MODE || config.APP_MODE || 'paper').toLowerCase() === 'paper';
    if (!isPaper || config.ST1_RESCUE_RADAR_PAPER_CLOSE_ENABLED !== true || !radarResult?.emergencyExit) {
      return { triggered: false, reason: 'PAPER_RESCUE_CLOSE_NOT_APPLICABLE' };
    }
    if (this.st1RescueCloseInProgress) return { triggered: false, reason: 'RESCUE_CLOSE_ALREADY_RUNNING' };
    const riskSide = radarResult.riskSide === 'SHORT' ? 'SHORT' : 'LONG';
    const targetSignal = riskSide === 'SHORT' ? 'SELL' : 'BUY';
    const targets = [...this.activePositions.values()].filter(
      (position) => this.isPositionBotManaged(position) && position.signal === targetSignal
    );
    if (targets.length === 0) return { triggered: false, reason: `NO_OPEN_${riskSide}` };
    this.st1RescueCloseInProgress = true;
    const closed = []; const failed = [];
    try {
      for (const position of targets) {
        try {
          const currentPrice = Number(position.lastMonitoredPrice || await this.orderService.getCurrentPrice(position.coin));
          const result = await this.closeManagedPositionAtMarket(position, currentPrice, 'ST1_RESCUE_RADAR');
          if (!result?.closed) throw new Error('PAPER_RESCUE_CLOSE_NOT_CONFIRMED');
          this.activePositions.delete(position.coin);
          this.recordClosedTrade(result.notification);
          await this.notifyClosedPosition(result.notification);
          closed.push(position.coin);
        } catch (error) {
          failed.push({ coin: position.coin, error: error.message });
          logger.error('ST1 Rescue Radar paper close failed', { coin: position.coin, error: error.message });
        }
      }
      this.st1RescueRadar.beginRecovery(Date.now(), radarResult.reason || 'ST1_RESCUE_RED', riskSide);
      await NotificationService.sendMessage(
        `🚨 <b>ST1 KURTARMA RADARI — RED</b>\n` +
        `Risk Altındaki Taraf: <code>${riskSide}</code>\n` +
        `Neden: <code>${radarResult.reason || 'ST1_RESCUE_RED'}</code>\n` +
        `PAPER Kapatılan: <code>${closed.length}/${targets.length}</code>\n` +
        `Başarısız: <code>${failed.length}</code>\n` +
        `Durum: <code>RECOVERY — ${riskSide}</code>`
      );
      return { triggered: true, closed, failed, riskSide };
    } finally {
      this.st1RescueCloseInProgress = false;
    }
  }

  isUnlimitedPaperPositions() {
    return String(process.env.APP_MODE || config.APP_MODE || 'paper').toLowerCase() === 'paper'
      && String(process.env.PAPER_UNLIMITED_POSITIONS ?? config.PAPER_UNLIMITED_POSITIONS) === 'true';
  }

  resolveMaxPositions() {
    if (this.isUnlimitedPaperPositions()) return Number.POSITIVE_INFINITY;
    const parsed = Number.parseInt(process.env.MAX_POSITIONS || String(DEFAULT_MAX_POSITIONS), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_POSITIONS;
  }

  resolveAccountingStatePath() {
    return path.resolve(process.cwd(), String(config.ACCOUNTING_STATE_FILE || 'data/accounting-state.json'));
  }

  restoreAccountingState() {
    // Unit tests must never inherit or mutate a developer/live accounting ledger.
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test'
      && process.env.ALLOW_TEST_ACCOUNTING_PERSISTENCE !== 'true') {
      return false;
    }

    try {
      const statePath = this.resolveAccountingStatePath();
      if (!fs.existsSync(statePath)) return false;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!state || Number(state.schema) !== 1) return false;

      if (state.tradeStats && typeof state.tradeStats === 'object') {
        this.tradeStats = { ...this.tradeStats, ...state.tradeStats };
      }
      this.realizedPnlForTradeSizeUsdt = Number(state.realizedGrossPnlUsdt || 0);
      this.totalCommissionUsdt = Number(state.totalCommissionUsdt || 0);
      this.accountingStartedAt = Number(state.accountingStartedAt || this.accountingStartedAt);
      this.accountingStartWalletUsdt = Number.isFinite(Number(state.accountingStartWalletUsdt))
        ? Number(state.accountingStartWalletUsdt)
        : null;
      this.paperWalletBalanceUsdt = this.paperWalletStartUsdt
        + this.realizedPnlForTradeSizeUsdt
        - this.totalCommissionUsdt;

      logger.info('Persistent accounting state restored', {
        openedTotal: this.tradeStats.openedTotal,
        completed: this.tradeStats.total,
        realizedGrossPnlUsdt: this.realizedPnlForTradeSizeUsdt,
        totalCommissionUsdt: this.totalCommissionUsdt,
        accountingStartWalletUsdt: this.accountingStartWalletUsdt
      });
      return true;
    } catch (error) {
      logger.warn('Persistent accounting state restore failed; starting clean', { error: error.message });
      return false;
    }
  }

  persistAccountingState() {
    // Keep Jest runs deterministic and isolated from any local/live ledger.
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test'
      && process.env.ALLOW_TEST_ACCOUNTING_PERSISTENCE !== 'true') {
      return false;
    }

    try {
      const statePath = this.resolveAccountingStatePath();
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const payload = {
        schema: 1,
        botName: config.BOT_NAME || 'AGROS',
        appVersion: config.APP_VERSION || null,
        accountingStartedAt: this.accountingStartedAt,
        accountingStartWalletUsdt: this.accountingStartWalletUsdt,
        tradeStats: this.tradeStats,
        realizedGrossPnlUsdt: this.realizedPnlForTradeSizeUsdt,
        totalCommissionUsdt: this.totalCommissionUsdt,
        netRealizedPnlUsdt: this.realizedPnlForTradeSizeUsdt - this.totalCommissionUsdt,
        updatedAt: Date.now()
      };
      const tempPath = `${statePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tempPath, statePath);
      return true;
    } catch (error) {
      logger.warn('Persistent accounting state save failed', { error: error.message });
      return false;
    }
  }

  async getAccountingSnapshot() {
    const botNetRealized = this.realizedPnlForTradeSizeUsdt - this.totalCommissionUsdt;
    if (this.orderService.isLiveTradingEnabled?.() && typeof this.orderService.getFuturesAccountSnapshot === 'function') {
      try {
        const account = await this.orderService.getFuturesAccountSnapshot();
        if (account && Number.isFinite(Number(account.walletBalance))) {
          if (!Number.isFinite(Number(this.accountingStartWalletUsdt))) {
            this.accountingStartWalletUsdt = Number(account.walletBalance);
            this.persistAccountingState();
          }
          return {
            initial: Number(this.accountingStartWalletUsdt),
            current: Number(account.walletBalance),
            available: account.availableBalance,
            unrealizedPnl: account.unrealizedPnl,
            marginBalance: account.marginBalance,
            realizedPnl: botNetRealized,
            botGrossRealizedPnl: this.realizedPnlForTradeSizeUsdt,
            botCommission: this.totalCommissionUsdt,
            source: account.source || 'BINANCE_FUTURES_ACCOUNT'
          };
        }
      } catch (error) {
        logger.warn('Live account snapshot unavailable; reporting bot ledger fallback', { error: error.message });
      }
    }

    return {
      initial: this.paperWalletStartUsdt,
      current: this.paperWalletBalanceUsdt,
      available: null,
      unrealizedPnl: null,
      marginBalance: null,
      realizedPnl: botNetRealized,
      botGrossRealizedPnl: this.realizedPnlForTradeSizeUsdt,
      botCommission: this.totalCommissionUsdt,
      source: this.orderService.isLiveTradingEnabled?.() ? 'BOT_LEDGER_FALLBACK' : 'PAPER_LEDGER'
    };
  }

  resolvePositionMonitorIntervalMs() {
    const fromEnv = parseInt(process.env.POSITION_MONITOR_INTERVAL_MS || '', 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 1000) {
      return fromEnv;
    }

    const fromConfig = Number(config.POSITION_MONITOR_INTERVAL_MS);
    if (Number.isFinite(fromConfig) && fromConfig >= 1000) {
      return Math.floor(fromConfig);
    }

    return DEFAULT_POSITION_MONITOR_INTERVAL_MS;
  }

  resolveTopCoinTargetCount() {
    return parseInt(process.env.TOP_COINS_COUNT || String(DEFAULT_TOP_COINS_COUNT), 10);
  }

  isEntrySymbolExcluded(symbol) {
    return config.EXCLUDED_ENTRY_SYMBOLS.has(String(symbol || '').trim().toUpperCase());
  }

  resolveSimilarityThresholdPercent() {
    const engineThreshold = Number(this.similarity?.threshold);
    return Number.isFinite(engineThreshold)
      ? engineThreshold * 100
      : DEFAULT_SIMILARITY_THRESHOLD;
  }

  resolveBreadthCandidateFetchLimit(topCoinLimit = this.resolveTopCoinTargetCount()) {
    const breadthTarget = Math.max(1, Number(config.MARKET_BREADTH_TOP_COINS) || 1);
    const multiplier = Math.max(1, Number(config.MARKET_BREADTH_CANDIDATE_MULTIPLIER) || 1);
    return Math.max(Number(topCoinLimit) || 1, breadthTarget * multiplier);
  }

  isFullAlignmentForAmbush(ambush, snapshot = this.marketBreadth?.current, now = Date.now()) {
    if (config.FULL_ALIGNMENT_EMA_READY_ENABLED !== true || !ambush?.expectedSignal || !snapshot) {
      return false;
    }
    const calculatedAt = Number(snapshot.calculatedAt);
    if (!Number.isFinite(calculatedAt) || now - calculatedAt > config.MARKET_BREADTH_MAX_RESULT_AGE_MS) {
      return false;
    }
    const direction = ambush.expectedSignal === 'BUY' ? TREND_TYPE.UP : TREND_TYPE.DOWN;
    const opposite = direction === TREND_TYPE.UP ? TREND_TYPE.DOWN : TREND_TYPE.UP;
    return ambush.btcTrend === direction
      && ambush.ethTrend === direction
      && snapshot.breadth15m?.state === direction
      && snapshot.breadth24h?.state !== opposite;
  }

  isEmaReadyReason(reason) {
    return /^EMA\d+_TOUCH_RECLAIM$/.test(String(reason || ''));
  }

  clearAmbushReadyState(ambush) {
    ambush.ready = false;
    ambush.readyAt = null;
    ambush.readyReason = null;
    ambush.readyRegime = null;
    ambush.st1Setup = null;
    ambush.st1LastFilterReason = null;
  }

  resolveIntervalMs(interval) {
    const match = String(interval || '').trim().toLowerCase().match(/^(\d+)(m|h|d)$/);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === 'm' ? 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return amount * multiplier;
  }

  findLatestSt1ConfirmedSetup(candles, signal, now = Date.now(), interval = DEFAULT_READY_TRIGGER_INTERVAL) {
    if (!Array.isArray(candles) || !['BUY', 'SELL'].includes(signal)) return null;

    const intervalMs = this.resolveIntervalMs(interval);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;

    // ST1 is defined only on fully closed 15m candles. This also protects the
    // direct market-data fallback from accidentally treating the live candle as
    // the confirmation candle.
    const closedCandles = candles.filter((candle) => {
      const closeTime = Number(candle?.closeTime);
      return Number.isFinite(closeTime) && closeTime <= now;
    });

    const minimumHistory = Math.max(
      Number(config.BOLLINGER_PERIOD),
      Number(config.ATR_PERIOD) + 1
    );
    if (closedCandles.length < minimumHistory + 1) return null;

    const entryWindowCandles = Number(config.ST1_ENTRY_WINDOW_CANDLES);
    // Only the latest N setup/confirmation pairs can still own a live N-candle
    // post-confirmation entry window. Older pairs are necessarily expired.
    const latestSetupIndex = closedCandles.length - 2;
    const earliestSetupIndex = Math.max(
      minimumHistory - 1,
      closedCandles.length - (entryWindowCandles + 1)
    );

    for (let setupIndex = latestSetupIndex; setupIndex >= earliestSetupIndex; setupIndex -= 1) {
      const setupCandle = closedCandles[setupIndex];
      const confirmationCandle = closedCandles[setupIndex + 1];
      const setupAnalysis = this.trigger.analyzeSt1BollingerSetup(
        closedCandles.slice(0, setupIndex + 1),
        signal,
        {
          atrPeriod: config.ATR_PERIOD,
          touchAtrMultiplier: config.ST1_BB_TOUCH_ATR_MULTIPLIER
        }
      );
      if (!setupAnalysis.triggered || !this.trigger.isSt1ConfirmationCandle(confirmationCandle, signal)) {
        continue;
      }

      const confirmationCloseTime = Number(confirmationCandle?.closeTime);
      if (!Number.isFinite(confirmationCloseTime)) continue;
      const entryWindowStartAt = confirmationCloseTime + 1;
      const entryWindowEndAt = confirmationCloseTime + (entryWindowCandles * intervalMs);
      if (now < entryWindowStartAt || now > entryWindowEndAt) {
        continue;
      }

      return {
        signal,
        setupOpenTime: Number(setupCandle?.openTime) || null,
        setupCloseTime: Number(setupCandle?.closeTime) || null,
        setupOpen: Number(setupCandle.open),
        setupHigh: Number(setupCandle.high),
        setupLow: Number(setupCandle.low),
        setupClose: Number(setupCandle.close),
        confirmationOpenTime: Number(confirmationCandle?.openTime) || null,
        confirmationCloseTime,
        confirmationOpen: Number(confirmationCandle.open),
        confirmationClose: Number(confirmationCandle.close),
        bodyBreakPrice: Number(setupAnalysis.bodyBreakPrice),
        bollingerLower: Number(setupAnalysis.bb?.lower),
        bollingerUpper: Number(setupAnalysis.bb?.upper),
        atr: Number(setupAnalysis.atr),
        bandTolerance: Number(setupAnalysis.tolerance),
        distanceToBand: Number(setupAnalysis.distanceToBand),
        entryWindowStartAt,
        entryWindowEndAt,
        entryWindowCandles
      };
    }

    return null;
  }

  getSt1EntryWindowCandleNumber(st1Setup, now = Date.now(), interval = DEFAULT_READY_TRIGGER_INTERVAL) {
    const intervalMs = this.resolveIntervalMs(interval);
    const startAt = Number(st1Setup?.entryWindowStartAt);
    const endAt = Number(st1Setup?.entryWindowEndAt);
    if (![intervalMs, startAt, endAt].every(Number.isFinite) || now < startAt || now > endAt) {
      return null;
    }
    return Math.floor((now - startAt) / intervalMs) + 1;
  }

  isSt1BodyBreakTriggered(st1Setup, currentPrice) {
    const price = Number(currentPrice);
    const bodyBreakPrice = Number(st1Setup?.bodyBreakPrice);
    if (![price, bodyBreakPrice].every(Number.isFinite)) return false;
    return st1Setup.signal === 'BUY' ? price > bodyBreakPrice : price < bodyBreakPrice;
  }

  evaluateSt1CoinDirection(candles, signal) {
    const fastPeriod = Number(config.ST1_COIN_EMA_FAST_PERIOD);
    const slowPeriod = Number(config.ST1_COIN_EMA_SLOW_PERIOD);
    if (!Array.isArray(candles) || candles.length < slowPeriod || !['BUY', 'SELL'].includes(signal)) {
      return { allowed: false, reason: 'ST1_COIN_TREND_DATA_INSUFFICIENT' };
    }

    const ema50 = this.trigger.calculateEMA(candles, fastPeriod);
    const ema200 = this.trigger.calculateEMA(candles, slowPeriod);
    const st = this.calculateFinalGateSupertrend(
      candles,
      Number(config.ST1_COIN_SUPERTREND_PERIOD),
      Number(config.ST1_COIN_SUPERTREND_MULTIPLIER)
    );
    if (![ema50, ema200].every(Number.isFinite) || !st?.direction) {
      return { allowed: false, reason: 'ST1_COIN_TREND_INDICATOR_UNAVAILABLE', ema50, ema200, supertrend: st?.direction || null };
    }

    const emaAligned = signal === 'BUY' ? ema50 > ema200 : ema50 < ema200;
    const requiredSupertrend = signal === 'BUY' ? 'UP' : 'DOWN';
    const supertrendAligned = st.direction === requiredSupertrend;
    return {
      allowed: emaAligned && supertrendAligned,
      reason: !emaAligned
        ? 'ST1_COIN_EMA50_200_MISMATCH'
        : !supertrendAligned
          ? 'ST1_COIN_SUPERTREND_MISMATCH'
          : 'ST1_COIN_DIRECTION_CONFIRMED',
      ema50,
      ema200,
      emaAligned,
      supertrend: st.direction,
      supertrendValue: st.value,
      supertrendClose: st.close,
      requiredSupertrend,
      supertrendAligned
    };
  }

  resolveAmbushRefreshIntervalMinutes() {
    const fromEnv = parseInt(process.env.AMBUSH_REFRESH_INTERVAL_MINUTES || '', 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
      return fromEnv;
    }

    const fromConfig = Number(config.AMBUSH_REFRESH_INTERVAL_MINUTES);
    if (Number.isFinite(fromConfig) && fromConfig > 0) {
      return Math.floor(fromConfig);
    }

    return DEFAULT_AMBUSH_REFRESH_INTERVAL_MINUTES;
  }

  resolveAmbushRefreshIntervalMs() {
    return Math.max(1, this.resolveAmbushRefreshIntervalMinutes()) * 60 * 1000;
  }

  resolveStrategyCandleCloseDelayMs() {
    const fromEnv = parseInt(process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS || '', 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv < 60000) {
      return fromEnv;
    }

    const fromConfig = Number(config.STRATEGY_CANDLE_CLOSE_DELAY_MS);
    if (Number.isFinite(fromConfig) && fromConfig >= 0 && fromConfig < 60000) {
      return Math.floor(fromConfig);
    }

    return config.STRATEGY_CANDLE_CLOSE_DELAY_MS;
  }

  calculateNextStrategyRunAt(now = Date.now()) {
    const currentBoundary = Math.floor(now / STRATEGY_CANDLE_INTERVAL_MS) * STRATEGY_CANDLE_INTERVAL_MS;
    const closeDelayMs = this.resolveStrategyCandleCloseDelayMs();
    let nextRunAt = currentBoundary + closeDelayMs;

    if (nextRunAt <= now) {
      nextRunAt += STRATEGY_CANDLE_INTERVAL_MS;
    }

    return nextRunAt;
  }

  scheduleNextStrategyCycle() {
    if (!this.running) {
      return;
    }

    const now = Date.now();
    const nextRunAt = this.calculateNextStrategyRunAt(now);
    const delayMs = Math.max(0, nextRunAt - now);

    logger.info('Next strategy monitoring cycle scheduled', {
      nextRunAt: new Date(nextRunAt).toISOString(),
      delayMs,
      closeDelayMs: this.resolveStrategyCandleCloseDelayMs()
    });

    this.strategyLoopHandle = setTimeout(async () => {
      this.strategyLoopHandle = null;
      if (!this.running) {
        return;
      }

      try {
        await this.runStrategyCycle();
      } finally {
        this.scheduleNextStrategyCycle();
      }
    }, delayMs);
  }

  resolveAmbushMonitorIntervalMs() {
    const fromEnv = parseInt(process.env.AMBUSH_MONITOR_INTERVAL_MS || '', 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 1000) return fromEnv;
    const fromConfig = Number(config.AMBUSH_MONITOR_INTERVAL_MS);
    if (Number.isFinite(fromConfig) && fromConfig >= 1000) return Math.floor(fromConfig);
    return DEFAULT_AMBUSH_MONITOR_INTERVAL_MS;
  }

  scheduleNextAmbushMonitorCycle(delayMs = this.resolveAmbushMonitorIntervalMs()) {
    if (!this.running) return;
    this.ambushMonitorLoopHandle = setTimeout(async () => {
      this.ambushMonitorLoopHandle = null;
      if (!this.running) return;
      try {
        await this.runAmbushMonitorCycle();
      } finally {
        this.scheduleNextAmbushMonitorCycle();
      }
    }, Math.max(0, delayMs));
  }

  buildAmbushScanResult(payload = {}) {
    const direction = this.getAmbushDirectionCounts();
    return {
      status: payload.status || 'FAILED',
      reason: payload.reason || null,
      targetCoins: Number.isFinite(payload.targetCoins) ? payload.targetCoins : this.resolveTopCoinTargetCount(),
      fetchedCoins: Number.isFinite(payload.fetchedCoins) ? payload.fetchedCoins : 0,
      scannedCoins: Number.isFinite(payload.scannedCoins) ? payload.scannedCoins : 0,
      qualifiedAmbushes: Number.isFinite(payload.qualifiedAmbushes) ? payload.qualifiedAmbushes : this.ambushList.size,
      btcTrend: payload.btcTrend || null,
      ethTrend: payload.ethTrend || null,
      similarityInterval: payload.similarityInterval || (process.env.SIMILARITY_INTERVAL || DEFAULT_SIMILARITY_INTERVAL),
      refreshIntervalMinutes: Number.isFinite(payload.refreshIntervalMinutes)
        ? payload.refreshIntervalMinutes
        : this.resolveAmbushRefreshIntervalMinutes(),
      threshold: Number.isFinite(payload.threshold)
        ? payload.threshold
        : this.resolveSimilarityThresholdPercent(),
      ambushCount: Number.isFinite(payload.ambushCount) ? payload.ambushCount : this.ambushList.size,
      longCount: Number.isFinite(payload.longCount) ? payload.longCount : direction.longCount,
      shortCount: Number.isFinite(payload.shortCount) ? payload.shortCount : direction.shortCount,
      breadth15m: payload.breadth15m || this.marketBreadth?.current?.breadth15m || null,
      breadthTargetCoins: Number.isFinite(payload.breadthTargetCoins)
        ? payload.breadthTargetCoins
        : Number(config.MARKET_BREADTH_TOP_COINS),
      breadthUniverseSize: Number.isFinite(payload.breadthUniverseSize)
        ? payload.breadthUniverseSize
        : Number(this.marketBreadth?.current?.universeSize || 0)
    };
  }

  async notifyAmbushScanResult(result) {
    if (!result) {
      return;
    }

    this.lastAmbushScanResult = {
      ...result,
      at: Date.now()
    };

    await NotificationService.sendAmbushSummary(result);
    if (config.ST1_ENTRY_FUNNEL_RADAR_ENABLED || config.ST1_RESCUE_RADAR_ENABLED) {
      let rescue = this.st1RescueRadar?.lastEvaluation || null;
      if (this.isSt1RescueRadarRuntimeEnabled()) {
        try { rescue = await this.evaluateSt1RescueRadar(); }
        catch (error) { logger.warn('ST1 rescue radar scan-report evaluation failed', { error: error.message }); }
      }
      if (typeof NotificationService.sendSt1EntryAndRescueRadar === 'function') {
        await NotificationService.sendSt1EntryAndRescueRadar({
          funnel: this.getEntryFunnelSnapshot({ reset: true }),
          rescue
        });
      } else {
        this.getEntryFunnelSnapshot({ reset: true });
      }
    }
  }

  async start() {
    this.running = true;
    this.startedAt = Date.now();
    const topCoinLimit = parseInt(process.env.TOP_COINS_COUNT || DEFAULT_TOP_COINS_COUNT, 10);
    const similarityInterval = process.env.SIMILARITY_INTERVAL || DEFAULT_SIMILARITY_INTERVAL;
    const maxPositions = this.resolveMaxPositions();
    const positionMonitorIntervalMs = this.resolvePositionMonitorIntervalMs();

    logger.info('Main Trading Loop Started (24/7)', {
      service: 'gptsono',
      strategyIntervalMs: STRATEGY_CANDLE_INTERVAL_MS,
      strategyCloseDelayMs: this.resolveStrategyCandleCloseDelayMs(),
      positionMonitorIntervalMs,
      maxPositions: Number.isFinite(maxPositions) ? maxPositions : 'SINIRSIZ_PAPER',
      topCoins: topCoinLimit,
      similarityInterval
    });

    const modeLabel = (process.env.APP_MODE || 'paper').toLowerCase() === 'live' ? 'LIVE_TRADING' : 'PAPER_TRADING';
    await NotificationService.sendMessage(
      'Trading Loop Active (24/7)\n' +
      `Mode: ${modeLabel}\nStrategy scan: 15m candle closes + ${this.resolveStrategyCandleCloseDelayMs() / 1000}s`
    );

    await this.syncLiveOpenPositionsOnStart(Number.isFinite(maxPositions) ? maxPositions : DEFAULT_MAX_POSITIONS);
    this.scheduleNextStrategyCycle();
    this.scheduleNextAmbushMonitorCycle(0);

    const initialUptimeMs = Date.now() - this.startedAt;
    const initialUptimeHours = Math.floor(initialUptimeMs / 3600000);
    const initialUptimeMinutes = Math.floor((initialUptimeMs % 3600000) / 60000);
    const initialAccounting = await this.getAccountingSnapshot();
    await NotificationService.sendOrUpdatePerformanceReport({
      uptime: `${initialUptimeHours}s ${initialUptimeMinutes}dk`,
      totalCompleted: this.tradeStats.total,
      stats: this.tradeStats,
      netPnl: Number(initialAccounting.realizedPnl || 0),
      totalCommission: this.totalCommissionUsdt,
      wallet: initialAccounting,
      openPositionCount: this.activePositions.size,
      ambushCount: this.ambushList.size,
      session: this.getSessionStatsSnapshot()
    });

    this.performanceReportLoopHandle = setInterval(async () => {
      const uptimeMs = Date.now() - this.startedAt;
      const uptimeHours = Math.floor(uptimeMs / 3600000);
      const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
      const accounting = await this.getAccountingSnapshot();
      await NotificationService.sendOrUpdatePerformanceReport({
        uptime: `${uptimeHours}s ${uptimeMinutes}dk`,
        totalCompleted: this.tradeStats.total,
        stats: this.tradeStats,
        netPnl: Number(accounting.realizedPnl || 0),
        totalCommission: this.totalCommissionUsdt,
        wallet: accounting,
        openPositionCount: this.activePositions.size,
        ambushCount: this.ambushList.size,
        session: this.getSessionStatsSnapshot()
      });
    }, config.PERFORMANCE_REPORT_INTERVAL_MS);
  }

  async runStrategyCycle() {
    if (this.isStrategyCycleRunning) {
      return;
    }

    this.isStrategyCycleRunning = true;
    try {
      const now = Date.now();
      const similarityInterval = process.env.SIMILARITY_INTERVAL || DEFAULT_SIMILARITY_INTERVAL;
      const btcTrendInterval = process.env.BTC_TREND_INTERVAL || config.BTC_TREND_INTERVAL;
      const trendRequiredCandles = Math.max(
        Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
        Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
      ) + 1;
      const trendCandleLimit = Math.max(
        trendRequiredCandles,
        Number(process.env.BTC_TREND_CANDLE_LIMIT || config.BTC_TREND_CANDLE_LIMIT || trendRequiredCandles)
      );
      const ambushRefreshIntervalMinutes = this.resolveAmbushRefreshIntervalMinutes();
      const ambushRefreshIntervalMs = this.resolveAmbushRefreshIntervalMs();
      const shouldRefreshAmbushes =
        this.lastAmbushRefreshAt === null ||
        (now - this.lastAmbushRefreshAt) >= ambushRefreshIntervalMs;
      let skipNewEntriesThisCycle = false;
      let ambushScanResult = null;

      if (shouldRefreshAmbushes) {
        let btcTrendCandles = null;
        let ethTrendCandles = null;
        let btcSimilarityCandles = null;
        let ethSimilarityCandles = null;
        try {
          btcTrendCandles = this.historicalCandleCache
            ? await this.historicalCandleCache.getOrFetchCandles(BTC_SYMBOL, btcTrendInterval, trendCandleLimit)
            : await this.marketData.getKlines(BTC_SYMBOL, btcTrendInterval, trendCandleLimit);
        } catch (error) {
          logger.warn('BTC candle fetch failed, skipping this cycle', {
            coin: BTC_SYMBOL,
            interval: btcTrendInterval,
            error: error.message
          });
        }
        try {
          ethTrendCandles = this.historicalCandleCache
            ? await this.historicalCandleCache.getOrFetchCandles('ETHUSDT', btcTrendInterval, trendCandleLimit)
            : await this.marketData.getKlines('ETHUSDT', btcTrendInterval, trendCandleLimit);
        } catch (error) {
          logger.warn('ETH trend candle fetch failed, rejecting new candidates for this cycle', {
            coin: 'ETHUSDT',
            interval: btcTrendInterval,
            error: error.message
          });
        }
        if (!btcTrendCandles || btcTrendCandles.length < trendRequiredCandles) {
          logger.warn('BTC similarity candles not available for ambush refresh', {
            interval: btcTrendInterval,
            expected: trendRequiredCandles,
            received: btcTrendCandles?.length || 0
          });
          skipNewEntriesThisCycle = true;
          logger.info('Scheduled ambush refresh skipped', {
            reason: 'BTC_TREND_DATA_UNAVAILABLE',
            btcSimilarity: null,
            ethSimilarity: null,
            combinedSimilarity: null,
            btcTrend: null,
            ethTrend: null
          });
          ambushScanResult = this.buildAmbushScanResult({
            status: 'SKIPPED',
            reason: 'BTC_TREND_DATA_UNAVAILABLE',
            similarityInterval,
            refreshIntervalMinutes: ambushRefreshIntervalMinutes,
            btcTrend: null,
            ethTrend: null
          });
        } else {
          if (!ethTrendCandles || ethTrendCandles.length < trendRequiredCandles) {
            logger.warn('ETH trend candles not available for ambush refresh', {
              interval: btcTrendInterval,
              expected: trendRequiredCandles,
              received: ethTrendCandles?.length || 0
            });
            skipNewEntriesThisCycle = true;
            logger.info('Scheduled ambush refresh skipped', {
              reason: 'ETH_TREND_DATA_UNAVAILABLE',
              btcSimilarity: null,
              ethSimilarity: null,
              combinedSimilarity: null,
              btcTrend: null,
              ethTrend: null
            });
            ambushScanResult = this.buildAmbushScanResult({
              status: 'SKIPPED',
              reason: 'ETH_TREND_DATA_UNAVAILABLE',
              similarityInterval,
              refreshIntervalMinutes: ambushRefreshIntervalMinutes,
              btcTrend: null,
              ethTrend: null
            });
          }

          if (skipNewEntriesThisCycle) {
            // Mandatory market data is missing; preserve current candidates and retry on next cycle.
          } else {
          this.candleService.btcTrendCandles = btcTrendCandles;
          try {
            btcSimilarityCandles = this.historicalCandleCache
              ? await this.historicalCandleCache.getOrFetchCandles(BTC_SYMBOL, similarityInterval, config.SIMILARITY_WINDOW_SIZE)
              : await this.marketData.getKlines(BTC_SYMBOL, similarityInterval, config.SIMILARITY_WINDOW_SIZE);
          } catch (error) {
            logger.warn('BTC similarity candle fetch failed, skipping this cycle', {
              coin: BTC_SYMBOL,
              interval: similarityInterval,
              error: error.message
            });
          }

          try {
            ethSimilarityCandles = this.historicalCandleCache
              ? await this.historicalCandleCache.getOrFetchCandles('ETHUSDT', similarityInterval, config.SIMILARITY_WINDOW_SIZE)
              : await this.marketData.getKlines('ETHUSDT', similarityInterval, config.SIMILARITY_WINDOW_SIZE);
          } catch (error) {
            logger.warn('ETH similarity candle fetch failed, rejecting new candidates for this cycle', {
              coin: 'ETHUSDT',
              interval: similarityInterval,
              error: error.message
            });
          }

          if (!btcSimilarityCandles || btcSimilarityCandles.length < config.SIMILARITY_WINDOW_SIZE) {
            logger.warn('BTC similarity candles not available for ambush refresh', {
              interval: similarityInterval,
              expected: config.SIMILARITY_WINDOW_SIZE,
              received: btcSimilarityCandles?.length || 0
            });
            skipNewEntriesThisCycle = true;
            logger.info('Scheduled ambush refresh skipped', {
              reason: 'BTC_SIMILARITY_DATA_UNAVAILABLE',
              btcSimilarity: null,
              ethSimilarity: null,
              combinedSimilarity: null,
              btcTrend: null,
              ethTrend: null
            });
            ambushScanResult = this.buildAmbushScanResult({
              status: 'SKIPPED',
              reason: 'BTC_SIMILARITY_DATA_UNAVAILABLE',
              similarityInterval,
              refreshIntervalMinutes: ambushRefreshIntervalMinutes,
              btcTrend: null,
              ethTrend: null
            });
          } else {
            if (!ethSimilarityCandles || ethSimilarityCandles.length < config.SIMILARITY_WINDOW_SIZE) {
              logger.warn('ETH similarity candles not available for ambush refresh', {
                interval: similarityInterval,
                expected: config.SIMILARITY_WINDOW_SIZE,
                received: ethSimilarityCandles?.length || 0
              });
              skipNewEntriesThisCycle = true;
              logger.info('Scheduled ambush refresh skipped', {
                reason: 'ETH_SIMILARITY_DATA_UNAVAILABLE',
                btcSimilarity: null,
                ethSimilarity: null,
                combinedSimilarity: null,
                btcTrend: null,
                ethTrend: null
              });
              ambushScanResult = this.buildAmbushScanResult({
                status: 'SKIPPED',
                reason: 'ETH_SIMILARITY_DATA_UNAVAILABLE',
                similarityInterval,
                refreshIntervalMinutes: ambushRefreshIntervalMinutes,
                btcTrend: null,
                ethTrend: null
              });
            } else {
              const btcTrend = await this.trend.analyzeTrend(
                btcTrendCandles,
                ethTrendCandles && ethTrendCandles.length >= trendRequiredCandles
                  ? ethTrendCandles
                  : null
              );
              const threshold = this.resolveSimilarityThresholdPercent();
              const trendEligibility = this.evaluateTrendAlignment(
                btcTrend?.btcTrend || btcTrend?.trend,
                btcTrend?.ethTrend
              );
              if (btcTrend?.btcTransitionLocked === true || btcTrend?.transitionLocked === true) {
                trendEligibility.allowed = false;
                trendEligibility.reason = 'BTC_EMA50_200_TRANSITION_LOCK';
              }

              if (!trendEligibility.allowed) {
                this.ambushList = new Map();
                this.lastAmbushRefreshAt = now;
                logger.info('Scheduled ambush refresh skipped', {
                  reason: trendEligibility.reason,
                  btcSimilarity: null,
                  ethSimilarity: null,
                  combinedSimilarity: null,
                  btcTrend: trendEligibility.btcTrend,
                  ethTrend: trendEligibility.ethTrend,
                  confidence: btcTrend?.confidence
                });
                ambushScanResult = this.buildAmbushScanResult({
                  status: 'SKIPPED',
                  reason: trendEligibility.reason,
                  similarityInterval,
                  refreshIntervalMinutes: ambushRefreshIntervalMinutes,
                  threshold,
                  btcTrend: trendEligibility.btcTrend || null,
                  ethTrend: trendEligibility.ethTrend || null,
                  ambushCount: 0,
                  longCount: 0,
                  shortCount: 0,
                  qualifiedAmbushes: 0
                });
              } else {
                const expectedSignalByTrend = trendEligibility.direction;
                const topCoinLimitForRefresh = this.resolveTopCoinTargetCount();
                const marketDataFetchLimit = this.resolveBreadthCandidateFetchLimit(topCoinLimitForRefresh);
                let topCoinsData = [];
                try {
                  topCoinsData = await this.marketData.getTop100Coins(marketDataFetchLimit);
                  try {
                    await this.marketBreadth.refresh(now, topCoinsData);
                  } catch (error) {
                    logger.warn('Weighted market breadth refresh failed', { error: error.message });
                  }
                } catch (error) {
                  skipNewEntriesThisCycle = true;
                  logger.warn('Top coins fetch failed for scheduled ambush refresh', {
                    error: error.message,
                    limit: topCoinLimitForRefresh
                  });
                  ambushScanResult = this.buildAmbushScanResult({
                    status: 'FAILED',
                    reason: 'TOP_COINS_FETCH_FAILED',
                    similarityInterval,
                    refreshIntervalMinutes: ambushRefreshIntervalMinutes,
                    threshold,
                    btcTrend: trendEligibility.btcTrend,
                    ethTrend: trendEligibility.ethTrend,
                    fetchedCoins: 0,
                    scannedCoins: 0
                  });
                }

                if (skipNewEntriesThisCycle) {
                  // Keep existing candidates and retry next cycle for temporary fetch errors.
                } else {
                const topCoins = topCoinsData
                  .slice(0, topCoinLimitForRefresh)
                  .map((coin) => String(coin?.symbol || '').trim().toUpperCase())
                  .filter((symbol) => symbol.length > 0 && !this.isEntrySymbolExcluded(symbol));
                const refreshedAmbushes = new Map();
                let scannedCoins = 0;

                for (const coin of topCoins) {
                  let marketCoinCandles = null;
                  try {
                    marketCoinCandles = this.historicalCandleCache
                      ? await this.historicalCandleCache.getOrFetchCandles(coin, similarityInterval, config.SIMILARITY_WINDOW_SIZE)
                      : await this.marketData.getKlines(coin, similarityInterval, config.SIMILARITY_WINDOW_SIZE);
                  } catch (error) {
                    logger.warn('Coin candle fetch failed, skipping this coin', {
                      coin,
                      interval: similarityInterval,
                      error: error.message
                    });
                  }
                  if (!marketCoinCandles || marketCoinCandles.length < config.SIMILARITY_WINDOW_SIZE) {
                    continue;
                  }

                  scannedCoins += 1;

                  try {
                    const similarity = await this.similarity.analyzeSimilarity(
                      marketCoinCandles,
                      btcSimilarityCandles,
                      ethSimilarityCandles
                    );
                    if (!similarity?.valid) {
                      logger.warn('Ambush candidate similarity invalid, skipping this coin', {
                        coin,
                        reason: similarity?.reason || 'SIMILARITY_INVALID'
                      });
                      continue;
                    }

                    const btcSimilarity = Number(similarity.btcSimilarity ?? similarity.score ?? 0);
                    const ethSimilarity = Number(similarity.ethSimilarity ?? 0);
                    const combinedSimilarity = Number(similarity.finalSimilarity ?? similarity.score ?? 0);

                    if (combinedSimilarity >= this.similarity.threshold) {
                      const refreshedAmbush = {
                        coin,
                        similarity: combinedSimilarity * 100,
                        metrics: {
                          btc: similarity.btcScores || similarity.scores || null,
                          eth: similarity.ethScores || null
                        },
                        btcMetrics: similarity.btcScores || similarity.scores || null,
                        ethMetrics: similarity.ethScores || null,
                        btcSimilarity: btcSimilarity * 100,
                        ethSimilarity: ethSimilarity * 100,
                        combinedSimilarity: combinedSimilarity * 100,
                        addedAt: now,
                        triggered: false,
                        ready: false,
                        readyAt: null,
                        trend: trendEligibility.btcTrend,
                        btcTrend: trendEligibility.btcTrend,
                        ethTrend: trendEligibility.ethTrend,
                        expectedSignal: expectedSignalByTrend,
                        direction: expectedSignalByTrend,
                        readyReason: null,
                        readyRegime: null
                      };
                      refreshedAmbushes.set(
                        coin,
                        preserveAmbushRuntimeState(refreshedAmbush, this.ambushList.get(coin))
                      );
                    } else {
                      logger.info('Ambush candidate rejected', {
                        coin,
                        reason: 'COMBINED_SIMILARITY_BELOW_THRESHOLD',
                        btcSimilarity: btcSimilarity * 100,
                        ethSimilarity: ethSimilarity * 100,
                        combinedSimilarity: combinedSimilarity * 100,
                        threshold,
                        btcTrend: trendEligibility.btcTrend,
                        ethTrend: trendEligibility.ethTrend
                      });
                    }
                  } catch (error) {
                    logger.error('Coin similarity analysis failed, skipping this coin', {
                      coin,
                      error: error.message,
                      stackTrace: error.stack || null
                    });
                  }
                }

                this.ambushList = refreshedAmbushes;
                this.lastAmbushRefreshAt = now;

                logger.info('Scheduled ambush refresh completed', {
                  topCoins: topCoins.length,
                  qualifiedAmbushes: this.ambushList.size,
                  btcCandles: btcTrendCandles.length,
                  trend: trendEligibility.btcTrend,
                  similarityInterval,
                  refreshIntervalMinutes: ambushRefreshIntervalMinutes
                });

                const fetchedCoins = topCoins.length;
                ambushScanResult = this.buildAmbushScanResult({
                  status: 'COMPLETED',
                  reason: null,
                  targetCoins: topCoinLimitForRefresh,
                  fetchedCoins,
                  scannedCoins,
                  qualifiedAmbushes: this.ambushList.size,
                  similarityInterval,
                  refreshIntervalMinutes: ambushRefreshIntervalMinutes,
                  threshold,
                  btcTrend: trendEligibility.btcTrend,
                  ethTrend: trendEligibility.ethTrend,
                  ambushCount: this.ambushList.size,
                  longCount: this.getAmbushDirectionCounts().longCount,
                  shortCount: this.getAmbushDirectionCounts().shortCount,
                  breadth15m: this.marketBreadth.current?.breadth15m || null
                });
              }
              }
            }
          }
          }
        }

        await this.notifyAmbushScanResult(ambushScanResult);
      }

      // Ağır yenileme burada biter; Bollinger ve 1m teyit ayrı zamanlayıcıda çalışır.
    } catch (error) {
      logger.error('Trading loop error', {
        error: error.message,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        endpoint: error.config?.url || null,
        requestId: error.response?.headers?.['x-request-id'] || error.response?.headers?.['x-mbx-uuid'] || null,
        coin: null,
        orderType: null,
        stackTrace: error.stack || null
      });
      await NotificationService.sendError('AMBUSH_REFRESH', error.message);
    } finally {
      this.isStrategyCycleRunning = false;
    }
  }

  async runAmbushMonitorCycle() {
    if (this.isAmbushMonitorCycleRunning) return;
    this.isAmbushMonitorCycleRunning = true;
    try {
      const notificationSummary = { opened: [], closed: [] };
      const now = Date.now();
      const maxPositions = this.resolveMaxPositions();
      const readyTriggerInterval = process.env.READY_BOLLINGER_INTERVAL || DEFAULT_READY_TRIGGER_INTERVAL;
      const ambushTimeoutMinutes = parseInt(
        process.env.AMBUSH_TIMEOUT_MINUTES || String(DEFAULT_AMBUSH_TIMEOUT_MINUTES),
        10
      );
      for (const [coin, ambush] of this.ambushList) {
        if (ambush.triggered) {
          continue;
        }

        let signal = null;
        let entryPrice = null;
        let coinCandles1m = null;
        let confirmation = null;

        if (config.ST1_ENTRY_ENGINE_ENABLED === true) {
          const st1CandleLimit = Math.max(
            Number(config.ST1_COIN_EMA_SLOW_PERIOD) + 20,
            Number(config.BOLLINGER_PERIOD) + Number(config.ATR_PERIOD) + 5
          );
          let st1Candles = null;
          try {
            st1Candles = this.historicalCandleCache
              ? await this.historicalCandleCache.getOrFetchCandles(coin, readyTriggerInterval, st1CandleLimit)
              : await this.marketData.getKlines(coin, readyTriggerInterval, st1CandleLimit);
          } catch (error) {
            logger.warn('ST1 15m candles fetch failed, skipping this coin', {
              coin,
              interval: readyTriggerInterval,
              error: error.message
            });
          }
          if (!st1Candles || st1Candles.length < st1CandleLimit) {
            continue;
          }

          if (ambush.st1Setup && now > Number(ambush.st1Setup.entryWindowEndAt)) {
            logger.info('ST1 setup expired after 3-candle entry window', {
              coin,
              signal: ambush.expectedSignal,
              setupOpenTime: ambush.st1Setup.setupOpenTime,
              confirmationOpenTime: ambush.st1Setup.confirmationOpenTime,
              entryWindowCandles: ambush.st1Setup.entryWindowCandles
            });
            this.clearAmbushReadyState(ambush);
          }

          const latestSt1Setup = this.findLatestSt1ConfirmedSetup(
            st1Candles,
            ambush.expectedSignal,
            now,
            readyTriggerInterval
          );
          const hasNewerSt1Setup = latestSt1Setup
            && (!ambush.st1Setup
              || Number(latestSt1Setup.confirmationCloseTime) > Number(ambush.st1Setup.confirmationCloseTime));

          if (hasNewerSt1Setup || (!ambush.ready && latestSt1Setup)) {
            const st1Setup = latestSt1Setup;
            ambush.ready = true;
            ambush.readyAt = now;
            ambush.readyReason = ambush.expectedSignal === 'BUY'
              ? 'ST1_LOWER_BB_RED_GREEN_CONFIRM'
              : 'ST1_UPPER_BB_GREEN_RED_CONFIRM';
            ambush.readyRegime = 'ST1_BB_15M_BODY_BREAK';
            ambush.st1Setup = st1Setup;
            ambush.st1LastFilterReason = null;
            this.markEntryFunnelStage(ambush.expectedSignal, 'setup', coin);

            logger.info('ST1 15m Bollinger setup armed', {
              coin,
              signal: ambush.expectedSignal,
              setupColor: ambush.expectedSignal === 'BUY' ? 'RED' : 'GREEN',
              confirmationColor: ambush.expectedSignal === 'BUY' ? 'GREEN' : 'RED',
              setupOpen: st1Setup.setupOpen,
              setupClose: st1Setup.setupClose,
              bodyBreakPrice: st1Setup.bodyBreakPrice,
              bollingerLower: st1Setup.bollingerLower,
              bollingerUpper: st1Setup.bollingerUpper,
              distanceToBand: st1Setup.distanceToBand,
              bandTolerance: st1Setup.bandTolerance,
              entryWindowCandles: st1Setup.entryWindowCandles
            });
          }

          if (!ambush.ready || !ambush.st1Setup) {
            continue;
          }

          const windowCandle = this.getSt1EntryWindowCandleNumber(ambush.st1Setup, now, readyTriggerInterval);
          if (!windowCandle || windowCandle > Number(config.ST1_ENTRY_WINDOW_CANDLES)) {
            continue;
          }

          let currentPrice = null;
          try {
            currentPrice = Number(await this.orderService.getCurrentPrice(coin));
          } catch (error) {
            logger.warn('ST1 current price fetch failed, skipping this coin', { coin, error: error.message });
            continue;
          }
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            continue;
          }

          if (!this.isSt1BodyBreakTriggered(ambush.st1Setup, currentPrice)) {
            continue;
          }
          this.markEntryFunnelStage(ambush.expectedSignal, 'bodyBreak', coin);

          const coinDirection = this.evaluateSt1CoinDirection(st1Candles, ambush.expectedSignal);
          if (!coinDirection.allowed) {
            if (ambush.st1LastFilterReason !== coinDirection.reason) {
              logger.info('ST1 body break waiting for coin EMA/SuperTrend alignment', {
                coin,
                signal: ambush.expectedSignal,
                windowCandle,
                currentPrice,
                bodyBreakPrice: ambush.st1Setup.bodyBreakPrice,
                ...coinDirection
              });
              ambush.st1LastFilterReason = coinDirection.reason;
            }
            this.markEntryFunnelRejection(ambush.expectedSignal, coin, coinDirection.reason);
            continue;
          }
          this.markEntryFunnelStage(ambush.expectedSignal, 'coinDirection', coin);
          ambush.st1LastFilterReason = null;

          try {
            const riskCandleLimit = Math.max(20, Number(config.ATR_PERIOD) + 1);
            coinCandles1m = this.historicalCandleCache
              ? await this.historicalCandleCache.getOrFetchCandles(coin, ONE_MIN_CONFIRM_INTERVAL, riskCandleLimit)
              : await this.marketData.getKlines(coin, ONE_MIN_CONFIRM_INTERVAL, riskCandleLimit);
          } catch (error) {
            logger.warn('ST1 risk candles fetch failed, skipping this coin', {
              coin,
              interval: ONE_MIN_CONFIRM_INTERVAL,
              error: error.message
            });
          }
          if (!coinCandles1m || coinCandles1m.length < Math.max(2, Number(config.ATR_PERIOD) + 1)) {
            continue;
          }

          signal = ambush.expectedSignal;
          entryPrice = currentPrice;
          ambush.direction = signal;
          confirmation = {
            confirmed: true,
            reason: 'ST1_15M_BB_CONFIRM_BODY_BREAK',
            features: {
              st1: true,
              windowCandle,
              bodyBreakPrice: ambush.st1Setup.bodyBreakPrice,
              currentPrice,
              ema50: coinDirection.ema50,
              ema200: coinDirection.ema200,
              coinSupertrend: coinDirection.supertrend
            }
          };

          logger.info('ST1 Entry Trigger Confirmed', {
            coin,
            signal,
            windowCandle,
            currentPrice,
            bodyBreakPrice: ambush.st1Setup.bodyBreakPrice,
            ema50: coinDirection.ema50,
            ema200: coinDirection.ema200,
            coinSupertrend: coinDirection.supertrend,
            requiredCoinSupertrend: coinDirection.requiredSupertrend
          });
        } else {
          if (
            ambush.ready
            && this.isEmaReadyReason(ambush.readyReason)
            && !this.isFullAlignmentForAmbush(ambush, this.marketBreadth?.current, now)
          ) {
            logger.info('EMA-ready ambush reset because full alignment was lost', {
              coin,
              expectedSignal: ambush.expectedSignal,
              previousReadyReason: ambush.readyReason,
              breadth15m: this.marketBreadth?.current?.breadth15m?.state || null,
              breadth24h: this.marketBreadth?.current?.breadth24h?.state || null
            });
            this.clearAmbushReadyState(ambush);
          }

          if (!ambush.ready) {
            const useFullAlignmentEma = this.isFullAlignmentForAmbush(
              ambush,
              this.marketBreadth?.current,
              now
            );
            const readyCandleLimit = useFullAlignmentEma
              ? Math.max(
                  Number(config.FULL_ALIGNMENT_EMA_PERIOD) + 10,
                  Number(config.ATR_PERIOD) + 1
                )
              : this.trigger.period;
            let readyCandles = null;
            try {
              readyCandles = this.historicalCandleCache
                ? await this.historicalCandleCache.getOrFetchCandles(coin, readyTriggerInterval, readyCandleLimit)
                : await this.marketData.getKlines(coin, readyTriggerInterval, readyCandleLimit);
            } catch (error) {
              logger.warn('Ready trigger candles fetch failed, skipping this coin', {
                coin,
                interval: readyTriggerInterval,
                error: error.message
              });
            }
            if (!readyCandles || readyCandles.length < readyCandleLimit) {
              continue;
            }

            const touch = useFullAlignmentEma
              ? this.trigger.analyzeEmaTouch(readyCandles, ambush.expectedSignal, {
                  emaPeriod: config.FULL_ALIGNMENT_EMA_PERIOD,
                  atrPeriod: config.ATR_PERIOD,
                  touchAtrMultiplier: config.FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER,
                  requireReclaim: config.FULL_ALIGNMENT_EMA_REQUIRE_RECLAIM,
                  requireSlope: config.FULL_ALIGNMENT_EMA_REQUIRE_SLOPE
                })
              : await this.trigger.analyzeTrigger(readyCandles);
            const inferredSignalFromBand =
              touch.type === 'LOWER_BAND'
                ? 'BUY'
                : touch.type === 'UPPER_BAND'
                  ? 'SELL'
                  : null;
            const touchedExpectedBand = !useFullAlignmentEma && ambush.expectedSignal
              ? (
                (ambush.expectedSignal === 'BUY' && touch.type === 'LOWER_BAND') ||
                (ambush.expectedSignal === 'SELL' && touch.type === 'UPPER_BAND')
              )
              : !useFullAlignmentEma && inferredSignalFromBand !== null;
            const readyConditionMet = useFullAlignmentEma
              ? touch.triggered === true
              : touch.triggered === true && touchedExpectedBand;

            if (readyConditionMet) {
              ambush.expectedSignal = ambush.expectedSignal || inferredSignalFromBand;
              ambush.direction = ambush.expectedSignal;
              ambush.ready = true;
              ambush.readyAt = Date.now();
              ambush.readyReason = touch.type;
              ambush.readyRegime = useFullAlignmentEma ? 'FULL_ALIGNMENT_EMA' : 'BOLLINGER';
              logger.info(useFullAlignmentEma
                ? 'Ambush ready after full-alignment EMA touch and reclaim'
                : 'Ambush ready after Bollinger touch', {
                coin,
                expectedSignal: ambush.expectedSignal,
                trend: ambush.trend,
                interval: readyTriggerInterval,
                reason: ambush.readyReason,
                readyRegime: ambush.readyRegime,
                ema: touch.ema ?? null,
                atr: touch.atr ?? null,
                tolerance: touch.tolerance ?? null
              });
            }

            if (!ambush.ready) {
              continue;
            }
          }

          try {
            coinCandles1m = this.historicalCandleCache
              ? await this.historicalCandleCache.getOrFetchCandles(coin, ONE_MIN_CONFIRM_INTERVAL, 20)
              : await this.marketData.getKlines(coin, ONE_MIN_CONFIRM_INTERVAL, 20);
          } catch (error) {
            logger.warn('Confirmation candles fetch failed, skipping this coin', {
              coin,
              interval: ONE_MIN_CONFIRM_INTERVAL,
              error: error.message
            });
          }
          if (!coinCandles1m || coinCandles1m.length < this.trigger.period) {
            continue;
          }

          confirmation = this.checkOneMinuteConfirmation(coinCandles1m, ambush.expectedSignal, ambush.trend);
          if (!confirmation.confirmed) {
            continue;
          }

          signal = ambush.expectedSignal;
          const lastCandle = coinCandles1m[coinCandles1m.length - 1];
          ambush.triggered = true;
          ambush.direction = signal;
          entryPrice = Number(lastCandle.close);

          logger.info('Trigger Confirmed (1m)', {
            coin,
            signal,
            confirmation: confirmation.reason,
            price: lastCandle.close
          });
        }

        if (Number.isFinite(maxPositions) && this.activePositions.size >= maxPositions) {
          logger.warn('Max active positions limit reached', {
            maxPositions,
            activePositions: this.activePositions.size
          });
          continue;
        }

        if (this.activePositions.has(coin)) {
          logger.warn('Position already active for coin', { coin });
          continue;
        }

        const projectedTpPercent = parseFloat(process.env.INITIAL_TP_PERCENT || DEFAULT_INITIAL_TP_PERCENT);
        const projectedStopLoss = this.estimateStructuralStopPrice(entryPrice, signal, coinCandles1m);
        const projectedRisk = Math.abs(entryPrice - projectedStopLoss);
        const projectedTakeProfit = this.getPositionFollowMode() === 'STAGED_R_ATR'
          ? (signal === 'BUY'
              ? entryPrice + (projectedRisk * config.STAGED_INITIAL_TP_R_MULTIPLIER)
              : entryPrice - (projectedRisk * config.STAGED_INITIAL_TP_R_MULTIPLIER))
          : (signal === 'BUY'
              ? entryPrice * (1 + (projectedTpPercent / 100))
              : entryPrice * (1 - (projectedTpPercent / 100)));

        const marketBreadth = this.marketBreadth.evaluate(signal, now);
        const breadthPolicy = this.evaluateSelectiveRegimePolicy(signal, null, marketBreadth);
        if (!breadthPolicy.allowed) {
          logger.warn('Entry rejected by market breadth policy', {
            coin,
            signal,
            verdict: marketBreadth.verdict,
            reason: breadthPolicy.reason,
            breadth15m: marketBreadth.breadth15m || null,
            breadth24h: marketBreadth.breadth24h || null
          });
          continue;
        }
        const estimatedTradeSizeUsdt = this.calculateRiskSizedTradeSize(
          entryPrice,
          signal,
          coinCandles1m,
          parseFloat(process.env.TRADE_SIZE_USDT || String(config.TRADE_SIZE_USDT)),
          breadthPolicy.targetRiskUsdt
        );
        if (estimatedTradeSizeUsdt == null) {
          logger.warn('Entry rejected because risk-sized notional is below minimum', { coin, signal });
          continue;
        }
        const estimatedQuantity = estimatedTradeSizeUsdt / entryPrice;
        const estimatedCostsUsdt = this.estimateRoundTripCosts(estimatedTradeSizeUsdt);
        const estimatedCostsPerUnit = estimatedCostsUsdt / Math.max(estimatedQuantity, EPSILON);
        const riskCheck = await this.riskManager.validateTrade(
          {
            id: `PRE_${coin}_${now}`,
            coin,
            signal,
            entryPrice,
            stopLoss: projectedStopLoss,
            takeProfit: projectedTakeProfit
          },
          Array.from(this.activePositions.values()),
          this.riskTradeHistory,
          {
            minRiskRewardRatio: config.PRE_TRADE_MIN_RISK_REWARD_RATIO,
            estimatedCostsPerUnit,
            projectedCommissionUsdt: estimatedTradeSizeUsdt * this.commissionRate * 2,
            projectedTurnoverUsdt: estimatedTradeSizeUsdt * 2
          }
        );

        if (!riskCheck.approved) {
          logger.warn('Risk check failed', {
            coin,
            reason: riskCheck.reason,
            checks: riskCheck.checks
          });
          continue;
        }

        logger.info('Weighted market breadth entry verdict', {
          coin,
          signal,
          verdict: marketBreadth.verdict,
          reason: marketBreadth.reason,
          breadth24h: marketBreadth.breadth24h || null,
          breadth15m: marketBreadth.breadth15m || null,
          momentum: marketBreadth.momentum ?? null
        });

        const entry = await this.enterPosition(
          coin,
          entryPrice,
          signal,
          coinCandles1m,
          ambush.similarity,
          marketBreadth,
          confirmation
        );

        if (entry) {
          this.markEntryFunnelStage(signal, 'opened', coin);
          ambush.triggered = true;
          ambush.direction = signal;
          this.activePositions.set(coin, entry.position);
          this.tradeStats.openedTotal += 1;
          this.sessionStats.openedTotal += 1;
          this.persistAccountingState();
          notificationSummary.opened.push(entry.notification);
          await NotificationService.sendEntry(
            entry.notification.coin,
            entry.notification.entryPrice,
            entry.notification.quantity,
            entry.notification.tp,
            entry.notification.sl,
            {
              signal: entry.notification.signal,
              mode: process.env.APP_MODE || 'paper',
              notionalUsdt: entry.position.executedNotionalUsdt ?? entry.position.tradeSizeUsdt,
              leverage: entry.notification.leverage
            }
          );
        }
      }

      const timeout = Math.max(1, ambushTimeoutMinutes) * 60 * 1000;
      for (const [coin, ambush] of this.ambushList) {
        const st1WindowStillActive = config.ST1_ENTRY_ENGINE_ENABLED === true
          && ambush.ready === true
          && Number.isFinite(Number(ambush.st1Setup?.entryWindowEndAt))
          && now <= Number(ambush.st1Setup.entryWindowEndAt);
        if (!ambush.triggered && !st1WindowStillActive && now - ambush.addedAt > timeout) {
          this.ambushList.delete(coin);
          logger.info('Ambush removed (trigger timeout)', {
            coin,
            timeoutMinutes: ambushTimeoutMinutes
          });
        }
      }

      if (notificationSummary.opened.length > 0 || notificationSummary.closed.length > 0) {
        const accounting = await this.getAccountingSnapshot();
        await NotificationService.sendTradeSummary({
          opened: notificationSummary.opened,
          closed: notificationSummary.closed,
          recentClosed: notificationSummary.closed.length > 0
            ? notificationSummary.closed
            : this.closedTradeHistory.slice(0, 3),
          ambushCount: this.ambushList.size,
          openPositionCount: this.activePositions.size,
          stats: this.tradeStats,
          wallet: accounting,
          commission: this.totalCommissionUsdt,
          mode: process.env.APP_MODE || 'paper',
          maxPositions,
          unlimitedPositions: this.isUnlimitedPaperPositions(),
          ambushDirection: this.getAmbushDirectionCounts(),
          positionDirection: this.getPositionDirectionCounts(),
          session: this.getSessionStatsSnapshot()
        });
      }
    } catch (error) {
      logger.error('Ambush monitor error', { error: error.message, stackTrace: error.stack || null });
      await NotificationService.sendError('AMBUSH_MONITOR', error.message);
    } finally {
      this.isAmbushMonitorCycleRunning = false;
    }
  }



  evaluateTrendAlignment(btcTrend, ethTrend, breadthSnapshot = this.marketBreadth?.current) {
    const normalizedBtcTrend = btcTrend || null;
    const normalizedEthTrend = ethTrend || null;
    const trendScore = (trend) => trend === TREND_TYPE.UP ? 1 : trend === TREND_TYPE.DOWN ? -1 : 0;
    const btcScore = trendScore(normalizedBtcTrend);
    const ethScore = trendScore(normalizedEthTrend);

    if (normalizedBtcTrend == null || normalizedEthTrend == null) {
      return {
        allowed: false,
        direction: null,
        reason: 'MARKET_TREND_DATA_UNAVAILABLE',
        score: 0,
        btcTrend: normalizedBtcTrend,
        ethTrend: normalizedEthTrend
      };
    }

    if (btcScore !== 0 && ethScore !== 0 && btcScore !== ethScore) {
      return {
        allowed: false,
        direction: null,
        reason: 'BTC_ETH_STRONG_CONFLICT',
        score: 0,
        btcTrend: normalizedBtcTrend,
        ethTrend: normalizedEthTrend
      };
    }

    const breadthIsFresh = breadthSnapshot
      && Number.isFinite(Number(breadthSnapshot.score))
      && (Date.now() - Number(breadthSnapshot.calculatedAt)) <= config.MARKET_BREADTH_MAX_RESULT_AGE_MS;
    const btcWeight = config.MARKET_TREND_BTC_WEIGHT;
    const ethWeight = config.MARKET_TREND_ETH_WEIGHT;
    const breadthWeight = breadthIsFresh ? config.MARKET_TREND_BREADTH_WEIGHT : 0;
    const activeWeight = btcWeight + ethWeight + breadthWeight;
    const score = activeWeight > 0
      ? ((btcScore * btcWeight)
        + (ethScore * ethWeight)
        + ((breadthIsFresh ? Number(breadthSnapshot.score) : 0) * breadthWeight)) / activeWeight
      : 0;
    const threshold = config.MARKET_TREND_ENTRY_SCORE;

    if (Math.abs(score) < threshold) {
      return {
        allowed: false,
        direction: null,
        reason: 'WEIGHTED_MARKET_TREND_SIDEWAYS',
        score,
        strong: false,
        breadthUsed: breadthIsFresh,
        btcTrend: normalizedBtcTrend,
        ethTrend: normalizedEthTrend
      };
    }

    return {
      allowed: true,
      direction: score > 0 ? 'BUY' : 'SELL',
      reason: 'WEIGHTED_MARKET_TREND_CONFIRMED',
      score,
      strong: Math.abs(score) >= config.MARKET_TREND_STRONG_SCORE,
      breadthUsed: breadthIsFresh,
      btcTrend: normalizedBtcTrend,
      ethTrend: normalizedEthTrend
    };
  }


  calculateFinalGateSupertrend(candles, period = 10, multiplier = 3) {
    const rows = (Array.isArray(candles) ? candles : [])
      .filter((candle) => [candle?.high, candle?.low, candle?.close].every((value) => Number.isFinite(Number(value))))
      .map((candle) => ({ ...candle, high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) }));
    if (rows.length < period + 2) return null;

    const tr = rows.map((candle, index) => {
      if (index === 0) return candle.high - candle.low;
      const previousClose = rows[index - 1].close;
      return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    });
    const atr = Array(rows.length).fill(null);
    atr[period - 1] = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let index = period; index < rows.length; index += 1) {
      atr[index] = ((atr[index - 1] * (period - 1)) + tr[index]) / period;
    }

    const upper = Array(rows.length).fill(null);
    const lower = Array(rows.length).fill(null);
    const supertrend = Array(rows.length).fill(null);
    const direction = Array(rows.length).fill(null);
    for (let index = period - 1; index < rows.length; index += 1) {
      const hl2 = (rows[index].high + rows[index].low) / 2;
      const basicUpper = hl2 + (multiplier * atr[index]);
      const basicLower = hl2 - (multiplier * atr[index]);
      if (index === period - 1) {
        upper[index] = basicUpper;
        lower[index] = basicLower;
        supertrend[index] = upper[index];
        direction[index] = 'DOWN';
        continue;
      }
      upper[index] = (basicUpper < upper[index - 1] || rows[index - 1].close > upper[index - 1])
        ? basicUpper : upper[index - 1];
      lower[index] = (basicLower > lower[index - 1] || rows[index - 1].close < lower[index - 1])
        ? basicLower : lower[index - 1];
      const previousWasUpper = Math.abs(supertrend[index - 1] - upper[index - 1]) <= EPSILON;
      direction[index] = previousWasUpper
        ? (rows[index].close > upper[index] ? 'UP' : 'DOWN')
        : (rows[index].close < lower[index] ? 'DOWN' : 'UP');
      supertrend[index] = direction[index] === 'UP' ? lower[index] : upper[index];
    }
    const last = rows.length - 1;
    return { direction: direction[last], value: supertrend[last], close: rows[last].close };
  }

  async evaluateFinalDirectionalEntryGate(_coin, signal, _marketBreadth = null) {
    if (signal !== 'BUY' && signal !== 'SELL') {
      return { allowed: false, mode: 'BLOCK', reason: 'FINAL_ST_INVALID_SIGNAL' };
    }

    try {
      const btc15m = await this.marketData.getKlines(BTC_SYMBOL, '15m', 300);
      const now = Date.now();
      const btcClosed = (Array.isArray(btc15m) ? btc15m : []).filter((candle) => {
        const closeTime = Number(candle?.closeTime ?? candle?.close_time ?? candle?.closeTimestamp);
        return !Number.isFinite(closeTime) || closeTime <= now;
      });
      const st = this.calculateFinalGateSupertrend(
        btcClosed,
        Number(config.FINAL_SUPERTREND_PERIOD || 10),
        Number(config.FINAL_SUPERTREND_MULTIPLIER || 3)
      );
      if (!st?.direction) {
        return { allowed: false, mode: 'BLOCK', reason: 'BTC15_ST_UNAVAILABLE' };
      }

      const requiredDirection = signal === 'BUY' ? 'UP' : 'DOWN';
      const allowed = st.direction === requiredDirection;
      return {
        allowed,
        mode: allowed ? 'STRICT_FINAL' : 'BLOCK',
        reason: allowed ? 'BTC15_ST_STRICT_CONFIRMED' : 'BTC15_ST_STRICT_MISMATCH',
        btc15Supertrend: st.direction,
        requiredDirection,
        btc15Close: st.close,
        btc15SupertrendValue: st.value
      };
    } catch (error) {
      return {
        allowed: false,
        mode: 'BLOCK',
        reason: 'FINAL_DIRECTIONAL_GATE_DATA_ERROR',
        error: error.message
      };
    }
  }

  async validateEntryTrend(expectedSignal) {
    const trendInterval = process.env.BTC_TREND_INTERVAL || config.BTC_TREND_INTERVAL;
    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;
    const trendCandleLimit = Math.max(
      trendRequiredCandles,
      Number(process.env.BTC_TREND_CANDLE_LIMIT || config.BTC_TREND_CANDLE_LIMIT || trendRequiredCandles)
    );

    try {
      const [btcCandles, ethCandles] = await Promise.all([
        this.marketData.getKlines(BTC_SYMBOL, trendInterval, trendCandleLimit),
        this.marketData.getKlines('ETHUSDT', trendInterval, trendCandleLimit)
      ]);

      if (
        !Array.isArray(btcCandles)
        || btcCandles.length < trendRequiredCandles
        || !Array.isArray(ethCandles)
        || ethCandles.length < trendRequiredCandles
      ) {
        return {
          allowed: false,
          reason: 'ENTRY_TREND_DATA_UNAVAILABLE',
          btcTrend: null,
          ethTrend: null
        };
      }

      const currentTrend = await this.trend.analyzeTrend(
        btcCandles,
        ethCandles
      );
      if (currentTrend?.btcTransitionLocked === true || currentTrend?.transitionLocked === true) {
        return {
          allowed: false,
          direction: currentTrend?.btcTrend === TREND_TYPE.UP ? 'BUY' : currentTrend?.btcTrend === TREND_TYPE.DOWN ? 'SELL' : null,
          reason: 'BTC_EMA50_200_TRANSITION_LOCK',
          btcTrend: currentTrend?.btcTrend || currentTrend?.trend || null,
          ethTrend: currentTrend?.ethTrend || null,
          ema50: currentTrend?.ema50 ?? null,
          ema200: currentTrend?.ema200 ?? null,
          emaGapPercent: currentTrend?.emaGapPercent ?? null
        };
      }
      const alignment = this.evaluateTrendAlignment(
        currentTrend?.btcTrend || currentTrend?.trend,
        currentTrend?.ethTrend
      );

      if (!alignment.allowed) {
        return alignment;
      }

      if (alignment.direction !== expectedSignal) {
        return {
          ...alignment,
          allowed: false,
          reason: 'ENTRY_SIGNAL_TREND_MISMATCH'
        };
      }

      return alignment;
    } catch (error) {
      logger.warn('Entry trend validation failed closed', {
        interval: trendInterval,
        expectedSignal,
        error: error.message
      });
      return {
        allowed: false,
        direction: null,
        reason: 'ENTRY_TREND_VALIDATION_FAILED',
        btcTrend: null,
        ethTrend: null
      };
    }
  }

  async monitorOpenPositions() {
    return this.monitorManagedPositions();
  }

  async monitorManagedPositions({ livePriceByCoin = null, skipLiveCachePriming = false } = {}) {
    if (this.isPositionCycleRunning) {
      return;
    }

    this.isPositionCycleRunning = true;
    try {
      const notificationSummary = { opened: [], closed: [] };
      if (this.orderService.isLiveTradingEnabled() && !skipLiveCachePriming) {
        await this.orderService.primePositionRiskCycleCache();
        await this.orderService.primeOpenOrdersCycleCache();
      }

      for (const [coin, position] of this.activePositions) {
        if (!this.isPositionBotManaged(position)) {
          if (this.shouldLogOwnershipWarning(coin, 'OWNERSHIP_NOT_BOT_CONFIRMED')) {
            logger.warn('Position management skipped because ownership is not BOT_CONFIRMED', {
              coin,
              ownership: position?.ownership || null,
              side: position?.signal || position?.side || null
            });
          }
          continue;
        }

        let coinCandles1m = null;
        try {
          coinCandles1m = this.historicalCandleCache
            ? await this.historicalCandleCache.getOrFetchCandles(coin, '1m', 20)
            : await this.marketData.getKlines(coin, '1m', 20);
        } catch (error) {
          logger.warn('Position monitor candle fetch failed, skipping this coin', {
            coin,
            interval: '1m',
            error: error.message
          });
        }
        if (!coinCandles1m || coinCandles1m.length === 0) {
          if (!this.orderService.isLiveTradingEnabled()) continue;
          try {
            const livePrice = livePriceByCoin instanceof Map && livePriceByCoin.has(coin)
              ? Number(livePriceByCoin.get(coin))
              : await this.orderService.getCurrentPrice(coin);
            const syntheticCandle = { open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: 0 };
            const result = await this.syncPositionLifecycle(position, syntheticCandle, [], livePrice);
            if (result?.closed) {
              this.activePositions.delete(coin);
              notificationSummary.closed.push(result.notification);
              this.recordClosedTrade(result.notification);
              await this.notifyClosedPosition(result.notification);
            }
          } catch (error) {
            logger.warn('Position management fallback failed while candles were unavailable', {
              coin,
              error: error.message
            });
          }
          continue;
        }

        const lastCandle = coinCandles1m[coinCandles1m.length - 1];
        let currentPrice = Number(lastCandle.close);

        if (this.orderService.isLiveTradingEnabled()) {
          if (livePriceByCoin instanceof Map && livePriceByCoin.has(coin)) {
            currentPrice = Number(livePriceByCoin.get(coin));
          } else {
            try {
              currentPrice = await this.orderService.getCurrentPrice(coin);
            } catch (error) {
              logger.warn('Position monitor live price fetch failed, skipping this coin', {
                coin,
                error: error.message
              });
              continue;
            }
          }

          if (!Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0) {
            logger.warn('Position monitor live price invalid, skipping this coin', {
              coin,
              currentPrice
            });
            continue;
          }
        }

        position.lastMonitoredPrice = Number(currentPrice);
        const result = await this.syncPositionLifecycle(position, lastCandle, coinCandles1m, Number(currentPrice));

        if (result?.closed) {
          this.activePositions.delete(coin);
          notificationSummary.closed.push(result.notification);
          this.recordClosedTrade(result.notification);
          await this.notifyClosedPosition(result.notification);
        }
      }

      if (notificationSummary.closed.length > 0) {
        const accounting = await this.getAccountingSnapshot();
        await NotificationService.sendTradeSummary({
          opened: [],
          closed: notificationSummary.closed,
          recentClosed: notificationSummary.closed,
          ambushCount: this.ambushList.size,
          openPositionCount: this.activePositions.size,
          stats: this.tradeStats,
          wallet: accounting,
          commission: this.totalCommissionUsdt,
          mode: process.env.APP_MODE || 'paper',
          maxPositions: this.resolveMaxPositions(),
          unlimitedPositions: this.isUnlimitedPaperPositions(),
          ambushDirection: this.getAmbushDirectionCounts(),
          positionDirection: this.getPositionDirectionCounts(),
          session: this.getSessionStatsSnapshot()
        });
      }
    } catch (error) {
      logger.error('Position monitor error', {
        error: error.message,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        endpoint: error.config?.url || null,
        requestId: error.response?.headers?.['x-request-id'] || error.response?.headers?.['x-mbx-uuid'] || null,
        coin: null,
        orderType: null,
        stackTrace: error.stack || null
      });
      await NotificationService.sendError('POSITION_MONITOR', error.message);
    } finally {
      this.orderService.clearPositionRiskCycleCache();
      this.orderService.clearOpenOrdersCycleCache();
      this.isPositionCycleRunning = false;
    }
  }

  isPositionBotManaged(position) {
    return String(position?.ownership || '').trim().toUpperCase() === 'BOT_CONFIRMED';
  }

  getOppositeSignal(signal) {
    return signal === 'BUY' ? 'SELL' : 'BUY';
  }

  getWarningThrottleKey(symbol, reason) {
    return `${String(symbol || '').toUpperCase()}::${String(reason || 'UNKNOWN')}`;
  }

  shouldLogOwnershipWarning(symbol, reason, cooldownMs = config.OWNERSHIP_WARNING_COOLDOWN_MS) {
    const now = Date.now();
    const key = this.getWarningThrottleKey(symbol, reason);
    const lastLoggedAt = Number(this.positionOwnershipWarnings.get(key) || 0);
    if ((now - lastLoggedAt) < cooldownMs) {
      return false;
    }

    this.positionOwnershipWarnings.set(key, now);
    return true;
  }

  isProtectionOrderPatternManaged(order, expectedProtectionSide) {
    if (!order) {
      return false;
    }

    const orderType = String(order.type || '').toUpperCase();
    const side = String(order.side || '').toUpperCase();
    const workingType = String(order.workingType || '').toUpperCase();
    const closePosition = String(order.closePosition).toLowerCase() === 'true';
    const isProtectionType = orderType === ORDER_TYPE.STOP_MARKET || orderType === ORDER_TYPE.TAKE_PROFIT_MARKET;

    return isProtectionType && side === expectedProtectionSide && workingType === 'MARK_PRICE' && closePosition;
  }

  async resolveLivePositionOwnership(livePosition, openOrders) {
    const signal = livePosition.side;
    const expectedProtectionSide = this.getProtectionSide(signal);
    const hasManagedStop = (openOrders || []).some(
      (order) => order.type === ORDER_TYPE.STOP_MARKET && this.isProtectionOrderPatternManaged(order, expectedProtectionSide)
    );
    const hasManagedTakeProfit = (openOrders || []).some(
      (order) => order.type === ORDER_TYPE.TAKE_PROFIT_MARKET && this.isProtectionOrderPatternManaged(order, expectedProtectionSide)
    );

    // The durable open snapshot is the bot-ownership proof. A missing stop is a
    // recoverable protection failure, not a reason to abandon the position after restart.
    const hasOpenSnapshot = await TradeSnapshotService.hasOpenSnapshotFor(
      livePosition.symbol,
      signal,
      livePosition.entryPrice,
      0.01
    );

    if (!hasOpenSnapshot) {
      return {
        managed: false,
        reason: 'OWNERSHIP_UNVERIFIED_NO_OPEN_SNAPSHOT_MATCH'
      };
    }

    if (!hasManagedStop) {
      return {
        managed: true,
        reason: 'OWNERSHIP_RECOVERED_FROM_OPEN_SNAPSHOT_MISSING_STOP'
      };
    }

    return {
      managed: true,
      reason: hasManagedTakeProfit
        ? 'OWNERSHIP_VERIFIED_FROM_PROTECTION_AND_OPEN_SNAPSHOT'
        : 'OWNERSHIP_VERIFIED_FROM_TRAILING_STOP_AND_OPEN_SNAPSHOT'
    };
  }

  buildPositionStateFromLivePosition(livePosition, options = {}) {
    const signal = livePosition.side;
    const tpPercent = parseFloat(process.env.INITIAL_TP_PERCENT || DEFAULT_INITIAL_TP_PERCENT);
    const slPercent = parseFloat(process.env.STOP_LOSS_PERCENT || DEFAULT_INITIAL_SL_PERCENT);
    const beTriggerPercent = parseFloat(process.env.BREAK_EVEN_TRIGGER_PERCENT || DEFAULT_BREAK_EVEN_TRIGGER_PERCENT);
    const trailingAtrMultiplier = parseFloat(process.env.TRAILING_ATR_MULTIPLIER || DEFAULT_TRAILING_ATR_MULTIPLIER);
    const trailingActivationAtrMultiplier = this.getPositiveConfigNumber(
      'TRAILING_ACTIVATION_ATR_MULTIPLIER',
      DEFAULT_TRAILING_ACTIVATION_ATR_MULTIPLIER
    );
    const protection = this.calculateProtectionPrices(livePosition.entryPrice, signal, tpPercent, slPercent);
    const expectedProtectionSide = this.getProtectionSide(signal);
    const stopOrder = this.getLatestOrder((options.openOrders || []).filter(
      (order) => order.side === expectedProtectionSide && order.type === ORDER_TYPE.STOP_MARKET
    ));

    return this.createPositionState({
      coin: livePosition.symbol,
      signal,
      leverage: Number(livePosition.leverage || process.env.LEVERAGE || 1),
      tradeSizeUsdt: Math.abs(Number(livePosition.notional || 0)),
      quantity: Number(livePosition.quantity),
      entryCommission: 0,
      entryOrderId: null,
      stopPrice: Number(stopOrder?.stopPrice || protection.stopPrice),
      stopOrderId: stopOrder?.id || null,
      takeProfitPrice: protection.takeProfitPrice,
      tpPercent,
      slPercent,
      breakEvenActivated: false,
      beTriggerPercent,
      trailingAtrMultiplier,
      trailingActivationAtrMultiplier,
      trailingActivationReached: false,
      trailingActivated: false,
      initialStopPrice: protection.stopPrice,
      highestPriceSinceEntry: Number(livePosition.entryPrice),
      lowestPriceSinceEntry: Number(livePosition.entryPrice),
      followStage: 'INITIAL',
      entryPrice: Number(livePosition.entryPrice),
      ownership: options.ownership || 'UNMANAGED'
    });
  }

  async syncManagedPositionsFromLivePositions(livePositions = []) {
    const liveBySymbol = new Map((livePositions || []).map((position) => [position.symbol, position]));

    for (const [symbol, state] of this.activePositions.entries()) {
      if (!liveBySymbol.has(symbol) && !this.isPositionBotManaged(state)) {
        this.activePositions.delete(symbol);
      }
    }

    for (const livePosition of liveBySymbol.values()) {
      const symbol = livePosition.symbol;
      const existing = this.activePositions.get(symbol);

      if (existing && this.isPositionBotManaged(existing)) {
        existing.ownership = 'BOT_CONFIRMED';
        continue;
      }

      let openOrders = [];
      try {
        openOrders = await this.orderService.getOpenOrders(symbol);
      } catch (error) {
        logger.warn('Ownership check open order fetch failed, marking as unmanaged', {
          coin: symbol,
          error: error.message
        });
      }

      const ownership = await this.resolveLivePositionOwnership(livePosition, openOrders);
      if (!ownership.managed) {
        if (this.shouldLogOwnershipWarning(symbol, ownership.reason)) {
          logger.warn('Live open position left unmanaged due to unverified ownership', {
            coin: symbol,
            reason: ownership.reason,
            side: livePosition.side,
            quantity: livePosition.quantity,
            entryPrice: livePosition.entryPrice
          });
        }
        continue;
      }

      const reattached = this.buildPositionStateFromLivePosition(livePosition, {
        ownership: 'BOT_CONFIRMED',
        openOrders
      });
      this.recoverStagedFollowState(reattached);
      await this.hydratePositionPriceMetadata(reattached);
      const protectionResult = await this.ensureProtectionOrdersWithRecovery(
        reattached,
        'LIVE_POSITION_REATTACH_PROTECTION_FAILED'
      );
      if (protectionResult?.closed) {
        continue;
      }

      reattached.breakEvenActivated = this.isBreakEvenActive(reattached);
      reattached.trailingActivated = reattached.breakEvenActivated && !this.isNearBreakEven(reattached, reattached.stopPrice);
      reattached.trailingActivationReached = reattached.trailingActivated;
      reattached.ownership = 'BOT_CONFIRMED';
      this.activePositions.set(symbol, reattached);

      logger.info('Reattached managed live position to monitor', {
        coin: symbol,
        side: reattached.signal,
        reason: ownership.reason
      });
    }
  }

  async runIndependentPositionMonitorCycle() {
    if (!this.running) {
      return;
    }

    if (!this.orderService.isLiveTradingEnabled()) {
      await this.monitorManagedPositions();
      if (this.isSt1RescueRadarRuntimeEnabled()) {
        try {
          const radarResult = await this.evaluateSt1RescueRadar();
          if (radarResult?.emergencyExit) await this.emergencyClosePaperPositionsForRescueRadar(radarResult);
        } catch (error) {
          logger.warn('ST1 Rescue Radar paper evaluation failed', { error: error.message });
        }
      }
      return;
    }

    let livePositions = [];
    try {
      livePositions = await this.orderService.getOpenPositions();
    } catch (error) {
      logger.warn('Independent monitor failed to fetch live open positions', {
        error: error.message
      });
      return;
    }

    this.orderService.primePositionRiskCycleCacheFromPositions(livePositions);
    try {
      await this.orderService.primeOpenOrdersCycleCache();
    } catch (error) {
      logger.warn('Independent monitor failed to prime open order cache, continuing with per-symbol lookups', {
        error: error.message
      });
    }

    try {
      await this.syncManagedPositionsFromLivePositions(livePositions);
      const livePriceByCoin = new Map(
        livePositions
          .map((position) => [position.symbol, Number(position.markPrice)])
          .filter(([, price]) => Number.isFinite(price) && price > 0)
      );

      await this.monitorManagedPositions({
        livePriceByCoin,
        skipLiveCachePriming: true
      });
    } finally {
      this.orderService.clearPositionRiskCycleCache();
      this.orderService.clearOpenOrdersCycleCache();
    }
  }

  async enterPosition(coin, price, signal, recentCandles = [], similarityPercent = null, marketBreadth = null, confirmation = null) {
    try {
      if (this.isEntrySymbolExcluded(coin)) {
        logger.warn('Position entry rejected because symbol is excluded', { coin, signal });
        return null;
      }

      if (this.st1RescueRadar?.recoveryActive && this.st1RescueRadar.isEntryBlocked(signal)) {
        this.markEntryFunnelRejection(signal, coin, 'RESCUE_RECOVERY_ENTRY_LOCK');
        logger.warn('Position entry rejected by ST1 Rescue Radar recovery lock', { coin, signal, riskSide: this.st1RescueRadar.recoverySide });
        return null;
      }

      const entryTrendGuard = await this.validateEntryTrend(signal);
      if (!entryTrendGuard.allowed) {
        this.markEntryFunnelRejection(signal, coin, entryTrendGuard.reason || 'BTC_ETH_TREND_GUARD');
        logger.warn('Position entry rejected by final BTC/ETH trend guard', {
          coin,
          signal,
          reason: entryTrendGuard.reason,
          currentDirection: entryTrendGuard.direction,
          btcTrend: entryTrendGuard.btcTrend,
          ethTrend: entryTrendGuard.ethTrend
        });
        return null;
      }
      this.markEntryFunnelStage(signal, 'trendGuard', coin);

      const regimePolicy = this.evaluateSelectiveRegimePolicy(signal, entryTrendGuard, marketBreadth);
      if (!regimePolicy.allowed) {
        this.markEntryFunnelRejection(signal, coin, regimePolicy.reason || 'BREADTH_POLICY');
        logger.warn('Position entry rejected by market breadth policy', { coin, signal, ...regimePolicy });
        return null;
      }
      this.markEntryFunnelStage(signal, 'breadth', coin);

      let planningCandles = recentCandles;
      if (this.isDelayedProtectionMode()) {
        try {
          planningCandles = this.historicalCandleCache
            ? await this.historicalCandleCache.getOrFetchCandles(
                coin,
                String(config.STRUCTURAL_SL_INTERVAL),
                Number(config.STRUCTURAL_SL_LOOKBACK)
              )
            : await this.marketData.getKlines(
                coin,
                String(config.STRUCTURAL_SL_INTERVAL),
                Number(config.STRUCTURAL_SL_LOOKBACK)
              );
        } catch (error) {
          logger.warn('Position entry rejected because structural planning candles are unavailable', {
            coin,
            interval: config.STRUCTURAL_SL_INTERVAL,
            error: error.message
          });
          return null;
        }
      }

      const leverage = parseFloat(process.env.LEVERAGE || String(config.LEVERAGE));
      const configuredTradeSizeUsdt = parseFloat(process.env.TRADE_SIZE_USDT || String(config.TRADE_SIZE_USDT));
      const tpPercent = parseFloat(process.env.INITIAL_TP_PERCENT || DEFAULT_INITIAL_TP_PERCENT);
      const slPercent = parseFloat(process.env.STOP_LOSS_PERCENT || DEFAULT_INITIAL_SL_PERCENT);
      const indicativeStopPrice = this.isDelayedProtectionMode()
        ? this.estimateStructuralStopPrice(price, signal, planningCandles)
        : this.calculateProtectionPrices(price, signal, tpPercent, slPercent).stopPrice;
      // TRADE_SIZE_USDT is a hard maximum, not a forced size.
      // Structural stop width + regime risk budget may shrink risky positions.
      const tradeSizeUsdt = this.calculateRiskSizedTradeSizeFromStop(
        price,
        indicativeStopPrice,
        configuredTradeSizeUsdt,
        regimePolicy.targetRiskUsdt
      );
      if (!Number.isFinite(tradeSizeUsdt) || tradeSizeUsdt <= 0) {
        logger.warn('Position entry rejected because risk-sized notional is invalid/below minimum', {
          coin,
          signal,
          configuredMaxNotionalUsdt: configuredTradeSizeUsdt,
          targetRiskUsdt: regimePolicy.targetRiskUsdt,
          indicativeStopPrice
        });
        return null;
      }
      const quantity = tradeSizeUsdt / price;
      const beTriggerPercent = parseFloat(process.env.BREAK_EVEN_TRIGGER_PERCENT || DEFAULT_BREAK_EVEN_TRIGGER_PERCENT);
      const trailingAtrMultiplier = parseFloat(process.env.TRAILING_ATR_MULTIPLIER || DEFAULT_TRAILING_ATR_MULTIPLIER);
      const trailingActivationAtrMultiplier = this.getPositiveConfigNumber(
        'TRAILING_ACTIVATION_ATR_MULTIPLIER',
        DEFAULT_TRAILING_ACTIVATION_ATR_MULTIPLIER
      );
      const entrySide = signal === 'BUY' ? 'BUY' : 'SELL';
      const plannedStructuralStopPercent = (Math.abs(Number(price) - Number(indicativeStopPrice)) / Number(price)) * 100;
      const plannedRiskUsdt = tradeSizeUsdt * (plannedStructuralStopPercent / 100);

      logger.info('Position Entry Planned', {
        coin,
        signal,
        sessionId: this.sessionId,
        entryPrice: price,
        leverage,
        configuredMaxNotionalUsdt: configuredTradeSizeUsdt,
        plannedNotionalUsdt: tradeSizeUsdt,
        targetRiskUsdt: regimePolicy.targetRiskUsdt,
        breadthRegime: regimePolicy.breadthState,
        plannedRiskUsdt,
        plannedStructuralStopPrice: indicativeStopPrice,
        structuralStopPercent: plannedStructuralStopPercent,
        beTriggerPercent,
        trailingAtrMultiplier,
        quantity
      });

      const indicativeProtection = this.calculateProtectionPricesFromStop(price, signal, tpPercent, indicativeStopPrice);
      const netAdvantage = this.evaluateNetAdvantage(price, indicativeProtection.takeProfitPrice, tradeSizeUsdt);
      if (!netAdvantage.passed) {
        logger.warn('Position entry rejected because estimated costs consume the advantage', {
          coin,
          signal,
          ...netAdvantage
        });
        return null;
      }

      const estimatedCostsPerUnit = netAdvantage.estimatedCostsUsdt / Math.max(quantity, EPSILON);
      const finalRiskCheck = await this.riskManager.validateTrade(
        {
          id: `FINAL_${coin}_${Date.now()}`,
          coin,
          signal,
          entryPrice: Number(price),
          stopLoss: indicativeStopPrice,
          takeProfit: indicativeProtection.takeProfitPrice
        },
        Array.from(this.activePositions.values()),
        this.riskTradeHistory,
        {
          minRiskRewardRatio: config.PRE_TRADE_MIN_RISK_REWARD_RATIO,
          estimatedCostsPerUnit,
          projectedCommissionUsdt: tradeSizeUsdt * this.commissionRate * 2,
          projectedTurnoverUsdt: tradeSizeUsdt * 2
        }
      );
      if (!finalRiskCheck.approved) {
        this.markEntryFunnelRejection(signal, coin, finalRiskCheck.reason || 'FINAL_RISK_CHECK');
        logger.warn('Position entry rejected by final risk check', {
          coin,
          signal,
          reason: finalRiskCheck.reason,
          checks: finalRiskCheck.checks
        });
        return null;
      }
      this.markEntryFunnelStage(signal, 'risk', coin);

      // ST1 is a reversal/transition strategy. BTC 15m SuperTrend is telemetry only:
      // it remains visible in the rescue radar but is never an entry authority.
      // Final directional authority stays with the fresh BTC/ETH EMA regime guard plus
      // the coin EMA50/EMA200 + coin SuperTrend direction gate above.

      const orderResult = await this.orderService.placeOrder({
        symbol: coin,
        side: entrySide,
        quantity,
        type: ORDER_TYPE.MARKET,
        reduceOnly: false
      });

      if (!orderResult?.success) {
        logger.error('Entry order failed', { coin, signal });
        return null;
      }

      const entryPrice = this.resolveEntryPrice(orderResult, price);
      const emergencyProtection = this.calculateProtectionPrices(
        entryPrice,
        signal,
        tpPercent,
        Math.min(Number(config.EMERGENCY_STOP_LOSS_PERCENT), Number(config.MAX_INITIAL_STOP_PERCENT))
      );
      const protection = this.calculateProtectionPrices(entryPrice, signal, tpPercent, slPercent);
      const executedQuantity = Number(orderResult.order?.executedQty || orderResult.order?.quantity || quantity);
      const positionNotionalUsdt = executedQuantity * entryPrice;
      if (positionNotionalUsdt > configuredTradeSizeUsdt + 1e-8) {
        logger.error('[CRITICAL] Executed entry exceeded configured notional hard cap', {
          coin,
          configuredMaxNotionalUsdt: configuredTradeSizeUsdt,
          executedNotionalUsdt: positionNotionalUsdt,
          executedQuantity,
          entryPrice,
          orderId: orderResult.orderId
        });
      }
      const structuralStopPercent = (Math.abs(entryPrice - Number(indicativeStopPrice)) / entryPrice) * 100;
      const executedRiskUsdt = positionNotionalUsdt * (structuralStopPercent / 100);
      // In LIVE, do not invent entry commission from a configured rate.
      // Binance userTrades will provide the actual entry+exit commissions at close.
      const entryCommission = this.orderService.isLiveTradingEnabled?.()
        ? 0
        : positionNotionalUsdt * this.commissionRate;
      if (!this.orderService.isLiveTradingEnabled?.()) {
        this.totalCommissionUsdt += entryCommission;
      }
      this.paperWalletBalanceUsdt = this.paperWalletStartUsdt + this.realizedPnlForTradeSizeUsdt - this.totalCommissionUsdt;
      const enteredAt = Date.now();
      const delayedProtectionEnabled = this.isDelayedProtectionMode();
      const protectionActivationAt = delayedProtectionEnabled
        ? enteredAt + this.resolveProtectionDelayMs()
        : enteredAt;
      const position = this.createPositionState({
        coin,
        signal,
        leverage,
        tradeSizeUsdt: positionNotionalUsdt,
        quantity: executedQuantity,
        entryCommission,
        entryOrderId: orderResult.orderId,
        entryPrice,
        stopPrice: delayedProtectionEnabled ? emergencyProtection.stopPrice : protection.stopPrice,
        takeProfitPrice: delayedProtectionEnabled ? null : protection.takeProfitPrice,
        tpPercent,
        slPercent,
        breakEvenActivated: false,
        beTriggerPercent,
        trailingAtrMultiplier,
        trailingActivationAtrMultiplier,
        trailingActivationReached: false,
        trailingActivated: false,
        initialStopPrice: delayedProtectionEnabled ? emergencyProtection.stopPrice : protection.stopPrice,
        highestPriceSinceEntry: entryPrice,
        lowestPriceSinceEntry: entryPrice,
        followStage: delayedProtectionEnabled ? 'PROTECTION_DELAY' : 'INITIAL',
        delayedProtectionEnabled,
        protectionActivationAt,
        enteredAt,
        btcTrend: entryTrendGuard.btcTrend,
        ethTrend: entryTrendGuard.ethTrend,
        ownership: 'BOT_CONFIRMED',
        marketBreadth,
        sessionId: this.sessionId,
        sessionStartedAt: this.sessionStartedAt,
        targetRiskUsdt: config.RISK_PER_TRADE_USDT,
        plannedRiskUsdt,
        executedRiskUsdt,
        plannedStructuralStopPrice: indicativeStopPrice,
        structuralStopPercent,
        configuredMaxNotionalUsdt: configuredTradeSizeUsdt,
        plannedNotionalUsdt: tradeSizeUsdt,
        executedNotionalUsdt: positionNotionalUsdt,
        requestedQuantity: quantity,
        executedQuantity
      });
      position.openCorrelationId = randomUUID();
      position.confirmationFeatures = confirmation?.features || null;
      position.regimePolicy = regimePolicy;
      await this.hydratePositionPriceMetadata(position);

      logger.info('Position Entry', {
        coin,
        signal,
        sessionId: this.sessionId,
        entryOrderId: position.entryOrderId,
        entryPrice,
        leverage,
        configuredMaxNotionalUsdt: configuredTradeSizeUsdt,
        plannedNotionalUsdt: tradeSizeUsdt,
        executedNotionalUsdt: positionNotionalUsdt,
        targetRiskUsdt: config.RISK_PER_TRADE_USDT,
        plannedRiskUsdt,
        executedRiskUsdt,
        plannedStructuralStopPrice: indicativeStopPrice,
        structuralStopPercent,
        emergencyStopPrice: emergencyProtection.stopPrice,
        requestedQuantity: quantity,
        executedQuantity,
        positionFollowMode: this.getPositionFollowMode()
      });

      const ambushContext = this.ambushList.get(coin);
      TradeSnapshotService.recordEntry({
        tradeId: position.entryOrderId,
        sessionId: this.sessionId,
        sessionStartedAt: this.sessionStartedAt,
        symbol: coin,
        side: signal,
        entryTime: position.enteredAt,
        entryPrice: position.entryPrice,
        btcTrend: entryTrendGuard.btcTrend || ambushContext?.trend || null,
        ethTrend: entryTrendGuard.ethTrend || null,
        similarityScore: similarityPercent,
        breadth15m: marketBreadth?.breadth15m || null,
        breadth24h: marketBreadth?.breadth24h || null,
        confirmationFeatures: confirmation?.features || null,
        confirmationReason: confirmation?.reason || null,
        plannedStopPrice: indicativeStopPrice,
        plannedStructuralStopPrice: indicativeStopPrice,
        emergencyStopPrice: emergencyProtection.stopPrice,
        structuralStopPrice: null,
        structuralStopPercent,
        takeProfitPrice: position.takeProfitPrice,
        targetRiskUsdt: config.RISK_PER_TRADE_USDT,
        plannedRiskUsdt,
        executedRiskUsdt,
        configuredMaxNotionalUsdt: configuredTradeSizeUsdt,
        plannedNotionalUsdt: tradeSizeUsdt,
        executedNotionalUsdt: positionNotionalUsdt,
        requestedQuantity: quantity,
        executedQuantity,
        positionFollowMode: this.getPositionFollowMode(),
        entryCommission,
        regimePolicy,
        appVersion: process.env.GITHUB_SHA || process.env.COMMIT_SHA || 'unknown',
        openCorrelationId: position.openCorrelationId,
        entryReason: [
          ambushContext?.readyReason || null,
          marketBreadth ? `BREADTH_SHADOW:${marketBreadth.verdict}:${marketBreadth.reason}` : null
        ].filter(Boolean).join('|') || null
      });

      const protectionResult = await this.ensureProtectionOrdersWithRecovery(
        position,
        'ENTRY_PROTECTION_SETUP_FAILED'
      );
      if (protectionResult?.closed) {
        return null;
      }

      return {
        position,
        notification: {
          coin,
          signal,
          similarityPercent,
          leverage,
          tradeSizeUsdt,
          entryPrice,
          quantity: position.quantity,
          tp: position.takeProfitPrice,
          sl: position.stopPrice,
          marketBreadth
        }
      };
    } catch (error) {
      logger.error('Entry failed', { error: error.message });
      return null;
    }
  }

  async notifyClosedPosition(notification) {
    if (!notification) return false;
    return NotificationService.sendExit(
      notification.coin,
      notification.entryPrice,
      notification.exitPrice,
      notification.netPnlForTradeSizeUsdt,
      notification.pnlPercent,
      notification.reason,
      this.tradeStats,
      {
        signal: notification.signal,
        mode: process.env.APP_MODE || 'paper',
        grossPnlUsdt: notification.pnlForTradeSizeUsdt,
        netPnlUsdt: notification.netPnlForTradeSizeUsdt,
        commissionUsdt: notification.totalTradeCommission,
        durationMs: notification.durationMs
      }
    );
  }

  recordClosedTrade(notification) {
    const normalized = {
      ...notification,
      closedAt: notification?.closedAt || Date.now(),
      profitLoss: Number(notification?.netPnlForTradeSizeUsdt ?? notification?.profitLoss ?? notification?.pnl ?? 0)
    };

    this.closedTradeHistory.unshift(normalized);
    this.closedTradeHistory = this.closedTradeHistory.slice(0, 20);
    this.riskTradeHistory.unshift(normalized);
  }

  async syncPositionLifecycle(position, candle, recentCandles = [], currentPriceOverride = null) {
    try {
      const fallbackPrice = Number(candle.close);
      const hasCurrentPriceOverride = Number.isFinite(Number(currentPriceOverride)) && Number(currentPriceOverride) > 0;
      const exitPrice = hasCurrentPriceOverride ? Number(currentPriceOverride) : fallbackPrice;

      if (this.orderService.isLiveTradingEnabled()) {
        const livePosition = await this.orderService.getOpenPosition(position.coin);
        if (!livePosition) {
          return this.finalizeLiveClosedPosition(position, exitPrice);
        }

        position.quantity = Number(livePosition.quantity || position.quantity);
        position.entryPrice = Number(livePosition.entryPrice || position.entryPrice);
        position.leverage = Number(livePosition.leverage || position.leverage);

      } else {
        const simulatedFill = await this.orderService.simulateProtectiveOrderFill(position, exitPrice);
        if (simulatedFill?.filledOrder) {
          return this.buildClosedPositionResult(
            position,
            this.resolveOrderFillPrice(simulatedFill.filledOrder, exitPrice, position),
            this.determineCloseReason(
              position,
              simulatedFill.filledOrder,
              this.resolveOrderFillPrice(simulatedFill.filledOrder, exitPrice, position)
            ),
            simulatedFill.filledOrder.id
          );
        }
      }

      if (position.followStage === 'PROTECTION_DELAY') {
        if (Date.now() < Number(position.protectionActivationAt)) {
          return { closed: false };
        }

        const delayedProtectionResult = await this.activateDelayedProtection(position, exitPrice);
        if (delayedProtectionResult?.closed) {
          return delayedProtectionResult;
        }
      }

      let protectionResult = null;
      try {
        await this.ensureProtectionOrders(position);
      } catch (protectionError) {
        protectionResult = await this.ensureProtectionOrdersWithRecovery(
          position,
          'POSITION_PROTECTION_FAILURE'
        );
      }
      if (protectionResult?.closed) {
        return protectionResult;
      }

      const favorableMovePercent = this.calculateFavorableMovePercent(position, exitPrice);
      const atrPeriod = this.resolveAtrPeriod();
      const atrValue = this.calculateAtrValue(recentCandles, atrPeriod);
      this.updatePositionExtremes(position, exitPrice);

      if (this.getPositionFollowMode() === 'STAGED_R_ATR') {
        await this.applyStagedPositionFollow(position, exitPrice, recentCandles, atrValue);
        return { closed: false };
      }

      const beAtrMultiplier = this.getPositiveConfigNumber('BE_ATR_MULTIPLIER', DEFAULT_BE_ATR_MULTIPLIER);
      const breakEvenTriggerPercent = this.calculateBreakEvenTriggerPercent(position, atrValue, beAtrMultiplier);
      const trailingActivationPercent = this.calculateTrailingActivationPercent(position, atrValue);

      if (
        !position.breakEvenActivated
        && Number.isFinite(breakEvenTriggerPercent)
        && favorableMovePercent >= breakEvenTriggerPercent
      ) {
        await this.activateBreakEven(position);
      }

      if (position.breakEvenActivated) {
        await this.updateDynamicTakeProfit(position, exitPrice, recentCandles, atrValue);
      }

      if (
        !position.trailingActivationReached
        && Number.isFinite(trailingActivationPercent)
        && favorableMovePercent >= trailingActivationPercent
      ) {
        position.trailingActivationReached = true;
      }

      if (position.trailingActivationReached) {
        await this.updateTrailingStop(position, exitPrice, recentCandles, atrValue);
      }

      return { closed: false };
    } catch (error) {
      logger.error('Exit check failed', {
        error: error.message,
        coin: position.coin,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        endpoint: error.config?.url || null,
        requestId: error.response?.headers?.['x-request-id'] || error.response?.headers?.['x-mbx-uuid'] || null,
        orderType: null,
        stackTrace: error.stack || null
      });
      const emergencyResult = await this.handleProtectionFailure(position, error, 'POSITION_PROTECTION_FAILURE');
      if (emergencyResult?.closed) {
        return emergencyResult;
      }
    }

    return null;
  }

  createPositionState(position) {
    const nullableNumber = (value) => value == null || value === ''
      ? null
      : (Number.isFinite(Number(value)) ? Number(value) : null);
    const initialStopPrice = nullableNumber(position.initialStopPrice ?? position.stopPrice);
    return {
      coin: position.coin,
      symbol: position.coin,
      signal: position.signal,
      side: position.signal,
      ownership: String(position.ownership || '').trim().toUpperCase() === 'BOT_CONFIRMED'
        ? 'BOT_CONFIRMED'
        : 'UNMANAGED',
      leverage: position.leverage,
      tradeSizeUsdt: position.tradeSizeUsdt,
      quantity: position.quantity,
      entryCommission: position.entryCommission || 0,
      entryOrderId: position.entryOrderId || null,
      stopOrderId: position.stopOrderId || null,
      takeProfitOrderId: position.takeProfitOrderId || null,
      entryPrice: Number(position.entryPrice),
      stopPrice: nullableNumber(position.stopPrice),
      sl: nullableNumber(position.stopPrice),
      takeProfitPrice: nullableNumber(position.takeProfitPrice),
      tp: nullableNumber(position.takeProfitPrice),
      tpPercent: position.tpPercent,
      slPercent: position.slPercent,
      breakEvenActivated: position.breakEvenActivated === true,
      trailingActivated: position.trailingActivated === true,
      trailingActivationReached: position.trailingActivationReached === true,
      beTriggerPercent: position.beTriggerPercent,
      trailingAtrMultiplier: position.trailingAtrMultiplier,
      trailingActivationAtrMultiplier: position.trailingActivationAtrMultiplier,
      tickSize: Number.isFinite(Number(position.tickSize)) ? Number(position.tickSize) : null,
      pricePrecision: position.pricePrecision != null && Number.isInteger(Number(position.pricePrecision))
        ? Number(position.pricePrecision)
        : null,
      enteredAt: position.enteredAt || Date.now(),
      delayedProtectionEnabled: position.delayedProtectionEnabled === true,
      protectionActivationAt: nullableNumber(position.protectionActivationAt),
      protectionActivationNotificationSent: position.protectionActivationNotificationSent === true,
      profitLockPrice: nullableNumber(position.profitLockPrice),
      marketBreadth: position.marketBreadth || null,
      sessionId: position.sessionId || this.sessionId || null,
      sessionStartedAt: nullableNumber(position.sessionStartedAt ?? this.sessionStartedAt),
      targetRiskUsdt: nullableNumber(position.targetRiskUsdt),
      plannedRiskUsdt: nullableNumber(position.plannedRiskUsdt),
      executedRiskUsdt: nullableNumber(position.executedRiskUsdt),
      plannedStructuralStopPrice: nullableNumber(position.plannedStructuralStopPrice),
      structuralStopPercent: nullableNumber(position.structuralStopPercent),
      configuredMaxNotionalUsdt: nullableNumber(position.configuredMaxNotionalUsdt),
      plannedNotionalUsdt: nullableNumber(position.plannedNotionalUsdt),
      executedNotionalUsdt: nullableNumber(position.executedNotionalUsdt ?? position.tradeSizeUsdt),
      requestedQuantity: nullableNumber(position.requestedQuantity),
      executedQuantity: nullableNumber(position.executedQuantity ?? position.quantity),
      initialStopPrice,
      initialRisk: initialStopPrice == null
        ? null
        : Math.abs(Number(position.entryPrice) - initialStopPrice),
      highestPriceSinceEntry: Number(position.highestPriceSinceEntry || position.entryPrice),
      lowestPriceSinceEntry: Number(position.lowestPriceSinceEntry || position.entryPrice),
      followStage: position.followStage || 'INITIAL',
      btcTrend: position.btcTrend || null,
      ethTrend: position.ethTrend || null
    };
  }

  async hydratePositionPriceMetadata(position) {
    if (typeof this.orderService.getSymbolPriceMetadata !== 'function') {
      return position;
    }

    try {
      const metadata = await this.orderService.getSymbolPriceMetadata(position.coin);
      position.tickSize = Number.isFinite(Number(metadata?.tickSize)) ? Number(metadata.tickSize) : position.tickSize;
      position.pricePrecision = Number.isInteger(Number(metadata?.pricePrecision))
        ? Number(metadata.pricePrecision)
        : position.pricePrecision;
    } catch (error) {
      logger.warn('Symbol price metadata unavailable; using precision fallback for BE tolerance', {
        coin: position.coin,
        error: error.message
      });
    }

    return position;
  }

  calculateProtectionPrices(entryPrice, signal, tpPercent, slPercent) {
    const stopPrice = signal === 'BUY'
      ? entryPrice * (1 - (slPercent / 100))
      : entryPrice * (1 + (slPercent / 100));
    const stagedTpDistance = Math.abs(entryPrice - stopPrice)
      * this.getPositiveConfigNumber('STAGED_INITIAL_TP_R_MULTIPLIER', 3);
    const takeProfitPrice = this.getPositionFollowMode() === 'STAGED_R_ATR'
      ? (signal === 'BUY' ? entryPrice + stagedTpDistance : entryPrice - stagedTpDistance)
      : (signal === 'BUY'
          ? entryPrice * (1 + (tpPercent / 100))
          : entryPrice * (1 - (tpPercent / 100)));

    return { stopPrice, takeProfitPrice };
  }

  calculateProtectionPricesFromStop(entryPrice, signal, tpPercent, stopPrice) {
    const risk = Math.abs(Number(entryPrice) - Number(stopPrice));
    const takeProfitPrice = this.getPositionFollowMode() === 'STAGED_R_ATR'
      ? (signal === 'BUY'
          ? Number(entryPrice) + (risk * config.STAGED_INITIAL_TP_R_MULTIPLIER)
          : Number(entryPrice) - (risk * config.STAGED_INITIAL_TP_R_MULTIPLIER))
      : (signal === 'BUY'
          ? Number(entryPrice) * (1 + (tpPercent / 100))
          : Number(entryPrice) * (1 - (tpPercent / 100)));
    return { stopPrice, takeProfitPrice };
  }

  calculateHardInitialStopPrice(entryPrice, signal) {
    const maxPercent = Number(config.MAX_INITIAL_STOP_PERCENT || config.STOP_LOSS_PERCENT || 1.5);
    const ratio = maxPercent / 100;
    return signal === 'BUY'
      ? Number(entryPrice) * (1 - ratio)
      : Number(entryPrice) * (1 + ratio);
  }

  applyInitialStopSafetyCap(entryPrice, signal, candidateStopPrice) {
    const hardStop = this.calculateHardInitialStopPrice(entryPrice, signal);
    const candidate = Number(candidateStopPrice);
    if (!Number.isFinite(candidate) || candidate <= 0) return hardStop;
    // BUY: higher stop is safer. SELL: lower stop is safer.
    return signal === 'BUY'
      ? Math.max(candidate, hardStop)
      : Math.min(candidate, hardStop);
  }

  calculatePercentProfitLockPrice(position) {
    const floorPercent = Number(config.PROFIT_LOCK_STOP_PERCENT || 0.35) / 100;
    return position.signal === 'BUY'
      ? Number(position.entryPrice) * (1 + floorPercent)
      : Number(position.entryPrice) * (1 - floorPercent);
  }

  calculateFavorableExtremePercent(position) {
    const entry = Number(position.entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return 0;
    const extreme = position.signal === 'BUY'
      ? Number(position.highestPriceSinceEntry)
      : Number(position.lowestPriceSinceEntry);
    if (!Number.isFinite(extreme) || extreme <= 0) return 0;
    return position.signal === 'BUY'
      ? ((extreme - entry) / entry) * 100
      : ((entry - extreme) / entry) * 100;
  }

  async enforcePercentProfitFloor(position, currentPrice = null) {
    const triggerPercent = Number(config.PROFIT_LOCK_TRIGGER_PERCENT || 1.0);
    const hasCurrentPrice = currentPrice != null
      && currentPrice !== ''
      && Number.isFinite(Number(currentPrice))
      && Number(currentPrice) > 0;
    const currentMovePercent = hasCurrentPrice
      ? this.calculateFavorableMovePercent(position, Number(currentPrice))
      : null;
    if (currentMovePercent != null && currentMovePercent <= 0) {
      return false;
    }
    if (this.calculateFavorableExtremePercent(position) + EPSILON < triggerPercent) {
      return false;
    }

    const floorPrice = this.calculatePercentProfitLockPrice(position);
    if (this.isStopImprovement(position, floorPrice)) {
      const replacement = await this.replaceManagedStopLoss(position, floorPrice, currentPrice);
      if (replacement?.noOp) return false;
      position.stopOrderId = replacement.orderId;
      position.stopPrice = Number(replacement.order?.stopPrice || floorPrice);
      position.sl = position.stopPrice;
      const notifiedStopPrice = Number(position.stopPrice.toFixed(12));
      await NotificationService.sendStopUpdate(position.coin, notifiedStopPrice, {
        signal: position.signal,
        reason: 'PERCENT_PROFIT_FLOOR_1PCT_TO_0_35'
      });
    }
    position.percentProfitFloorActivated = true;
    return true;
  }

  estimateStructuralStopPrice(entryPrice, signal, candles) {
    const minimumDistance = Number(entryPrice) * (Number(config.MIN_EFFECTIVE_STOP_PERCENT) / 100);
    if (!Array.isArray(candles) || candles.length < 2) {
      return signal === 'BUY' ? Number(entryPrice) - minimumDistance : Number(entryPrice) + minimumDistance;
    }
    const window = candles.slice(-Math.min(candles.length, Number(config.STRUCTURAL_SL_LOOKBACK)));
    const extreme = signal === 'BUY'
      ? Math.min(...window.map((candle) => Number(candle.low)))
      : Math.max(...window.map((candle) => Number(candle.high)));
    const percentageBuffer = extreme * (Number(config.STRUCTURAL_SL_BUFFER_PERCENT) / 100);
    const atrBuffer = this.calculateAtrValue(window, this.resolveAtrPeriod())
      * Number(config.STRUCTURAL_SL_ATR_BUFFER_MULTIPLIER);
    const rawStop = signal === 'BUY'
      ? extreme - Math.max(percentageBuffer, atrBuffer)
      : extreme + Math.max(percentageBuffer, atrBuffer);
    const structuralStop = signal === 'BUY'
      ? Math.min(rawStop, Number(entryPrice) - minimumDistance)
      : Math.max(rawStop, Number(entryPrice) + minimumDistance);
    return this.applyInitialStopSafetyCap(entryPrice, signal, structuralStop);
  }

  calculateRiskSizedTradeSize(
    entryPrice,
    signal,
    candles,
    configuredMaximum,
    targetRiskUsdt = config.RISK_PER_TRADE_USDT
  ) {
    const stopPrice = this.estimateStructuralStopPrice(entryPrice, signal, candles);
    return this.calculateRiskSizedTradeSizeFromStop(
      entryPrice,
      stopPrice,
      configuredMaximum,
      targetRiskUsdt
    );
  }

  calculateRiskSizedTradeSizeFromStop(
    entryPrice,
    stopPrice,
    configuredMaximum,
    targetRiskUsdt = config.RISK_PER_TRADE_USDT
  ) {
    const stopRatio = Math.abs(Number(entryPrice) - stopPrice) / Number(entryPrice);
    const numericTargetRiskUsdt = Number(targetRiskUsdt);
    if (!Number.isFinite(stopRatio) || stopRatio <= 0 || !Number.isFinite(numericTargetRiskUsdt) || numericTargetRiskUsdt <= 0) {
      return null;
    }
    const riskSizedNotional = numericTargetRiskUsdt / stopRatio;
    const notional = Math.min(Number(configuredMaximum), riskSizedNotional);
    return Number.isFinite(notional) && notional >= Number(config.MIN_RISK_SIZED_TRADE_USDT)
      ? notional
      : null;
  }

  estimateRoundTripCosts(notionalUsdt) {
    return (Number(notionalUsdt) * this.commissionRate * 2)
      + (Number(notionalUsdt) * (Number(config.ESTIMATED_SLIPPAGE_PERCENT) / 100));
  }

  evaluateNetAdvantage(entryPrice, targetPrice, notionalUsdt) {
    const grossMoveRatio = Math.abs(Number(targetPrice) - Number(entryPrice)) / Number(entryPrice);
    const grossAdvantageUsdt = Number(notionalUsdt) * grossMoveRatio;
    const estimatedCostsUsdt = this.estimateRoundTripCosts(notionalUsdt);
    const netAdvantageUsdt = grossAdvantageUsdt - estimatedCostsUsdt;
    return {
      passed: netAdvantageUsdt + EPSILON >= Number(config.MIN_EXPECTED_NET_ADVANTAGE_USDT),
      grossAdvantageUsdt,
      estimatedCostsUsdt,
      netAdvantageUsdt
    };
  }

  evaluateSelectiveRegimePolicy(signal, _trendGuard, marketBreadth) {
    const verdict = marketBreadth?.verdict || 'WOULD_VETO';
    const breadthState = marketBreadth?.breadth15m?.state || 'MISSING';
    const expectedBreadth = signal === 'BUY' ? 'UP' : 'DOWN';
    const oppositeBreadth = expectedBreadth === 'UP' ? 'DOWN' : 'UP';

    // Missing/stale/invalid breadth is a data-quality failure and remains fail-closed.
    const hardDataFailure = !marketBreadth
      || breadthState === 'MISSING'
      || breadthState === 'INVALID'
      || marketBreadth?.reason === 'BREADTH_MISSING_OR_STALE';
    if (hardDataFailure) {
      return {
        allowed: false,
        reason: marketBreadth?.reason || 'BREADTH_MISSING_OR_STALE',
        verdict,
        breadthState,
        targetRiskUsdt: 0
      };
    }

    const configuredRiskUsdt = Number(config.RISK_PER_TRADE_USDT);
    const neutralRiskUsdt = Number(config.MARKET_BREADTH_NEUTRAL_RISK_USDT);
    const opposedRiskUsdt = Number(config.MARKET_BREADTH_OPPOSED_RISK_USDT);

    let targetRiskUsdt = configuredRiskUsdt;
    let reason = 'BREADTH_CONFIRMED_FULL_RISK';
    if (breadthState === 'NEUTRAL') {
      targetRiskUsdt = neutralRiskUsdt;
      reason = 'BREADTH_NEUTRAL_REDUCED_RISK';
    } else if (breadthState === oppositeBreadth) {
      targetRiskUsdt = opposedRiskUsdt;
      reason = 'BREADTH_OPPOSED_MIN_RISK';
    } else if (breadthState !== expectedBreadth) {
      targetRiskUsdt = neutralRiskUsdt;
      reason = 'BREADTH_UNCERTAIN_REDUCED_RISK';
    }

    return {
      allowed: true,
      reason,
      verdict,
      breadthState,
      expectedBreadth,
      targetRiskUsdt
    };
  }

  isDelayedProtectionMode() {
    const appMode = String(config.APP_MODE || process.env.APP_MODE || '').toLowerCase();
    const isSupportedMode = appMode === 'paper'
      || (appMode === 'live' && config.ENABLE_REAL_TRADING === true);

    return config.DELAYED_PROTECTION_ENABLED === true
      && isSupportedMode
      && this.getPositionFollowMode() === 'STAGED_R_ATR';
  }

  resolveProtectionDelayMs(randomValue = Math.random()) {
    const minMs = Math.max(0, Number(config.PROTECTION_DELAY_MIN_MS));
    const maxMs = Math.max(minMs, Number(config.PROTECTION_DELAY_MAX_MS));
    const normalizedRandom = Math.min(1, Math.max(0, Number(randomValue) || 0));
    return Math.floor(minMs + ((maxMs - minMs) * normalizedRandom));
  }

  normalizeStructuralStopPrice(position, price) {
    const numericPrice = Number(price);
    const hasPriceMetadata = (Number.isFinite(Number(position?.tickSize)) && Number(position.tickSize) > 0)
      || (position?.pricePrecision != null && Number.isInteger(Number(position.pricePrecision)));
    if (!hasPriceMetadata) return numericPrice;
    const step = this.resolvePriceStep(position);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0 || !Number.isFinite(step) || step <= 0) {
      return numericPrice;
    }

    const units = numericPrice / step;
    const normalized = position.signal === 'BUY'
      ? Math.floor(units + EPSILON) * step
      : Math.ceil(units - EPSILON) * step;
    const precision = position.pricePrecision != null && Number.isInteger(Number(position.pricePrecision))
      ? Number(position.pricePrecision)
      : Math.max(0, Math.ceil(-Math.log10(step)));
    return Number(normalized.toFixed(Math.min(precision, 16)));
  }

  calculateStructuralStopPrice(position, candles) {
    const lookback = Number(config.STRUCTURAL_SL_LOOKBACK);
    if (!Array.isArray(candles) || candles.length < lookback) {
      throw new Error(`STRUCTURAL_SL_REQUIRES_${lookback}_CLOSED_CANDLES`);
    }

    const window = candles.slice(-lookback);
    const bufferRatio = Number(config.STRUCTURAL_SL_BUFFER_PERCENT) / 100;
    const atrBufferMultiplier = this.getPositiveConfigNumber('STRUCTURAL_SL_ATR_BUFFER_MULTIPLIER', 0.5);
    const extreme = position.signal === 'BUY'
      ? Math.min(...window.map((candle) => Number(candle.low)))
      : Math.max(...window.map((candle) => Number(candle.high)));
    if (!Number.isFinite(extreme) || extreme <= 0) {
      throw new Error('STRUCTURAL_SL_EXTREME_INVALID');
    }

    const percentageBuffer = extreme * bufferRatio;
    const atrBuffer = this.calculateAtrValue(window, this.resolveAtrPeriod()) * atrBufferMultiplier;
    const bufferDistance = Math.max(percentageBuffer, atrBuffer);
    let rawStop = position.signal === 'BUY'
      ? extreme - bufferDistance
      : extreme + bufferDistance;
    if (String(config.APP_MODE).toLowerCase() === 'paper') {
      const minimumDistance = Number(position.entryPrice) * (Number(config.MIN_EFFECTIVE_STOP_PERCENT) / 100);
      rawStop = position.signal === 'BUY'
        ? Math.min(rawStop, Number(position.entryPrice) - minimumDistance)
        : Math.max(rawStop, Number(position.entryPrice) + minimumDistance);
    }
    const cappedStop = this.applyInitialStopSafetyCap(position.entryPrice, position.signal, rawStop);
    return this.normalizeStructuralStopPrice(position, cappedStop);
  }

  calculateGrossProfitLockPrice(position) {
    const quantity = Math.abs(Number(position.quantity));
    const tradeSizeUsdt = Number(position.tradeSizeUsdt);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(tradeSizeUsdt) || tradeSizeUsdt <= 0) {
      throw new Error('PROFIT_LOCK_POSITION_SIZE_INVALID');
    }

    const profitUsdt = tradeSizeUsdt * (Number(config.FIRST_PROFIT_LOCK_PERCENT) / 100);
    const priceDistance = profitUsdt / quantity;
    return position.signal === 'BUY'
      ? Number(position.entryPrice) + priceDistance
      : Number(position.entryPrice) - priceDistance;
  }

  isPriceBeyondStop(position, currentPrice, stopPrice) {
    return position.signal === 'BUY'
      ? Number(currentPrice) <= Number(stopPrice)
      : Number(currentPrice) >= Number(stopPrice);
  }

  async closeManagedPositionAtMarket(position, currentPrice, reason = 'SL') {
    if (!this.isPositionBotManaged(position)) {
      const error = new Error('Position close blocked: ownership is not BOT_CONFIRMED');
      error.code = 'POSITION_OWNERSHIP_UNVERIFIED';
      throw error;
    }

    const closeResult = await this.orderService.placeOrder({
      symbol: position.coin,
      side: this.getProtectionSide(position.signal),
      quantity: position.quantity,
      type: ORDER_TYPE.MARKET,
      reduceOnly: true
    });
    return this.buildClosedPositionResult(
      position,
      this.resolveEntryPrice(closeResult, currentPrice),
      reason,
      closeResult?.orderId || null
    );
  }

  async activateDelayedProtection(position, currentPrice) {
    const interval = String(config.STRUCTURAL_SL_INTERVAL);
    const lookback = Number(config.STRUCTURAL_SL_LOOKBACK);
    const candles = this.historicalCandleCache
      ? await this.historicalCandleCache.getOrFetchCandles(position.coin, interval, lookback)
      : await this.marketData.getKlines(position.coin, interval, lookback);
    const stopPrice = this.calculateStructuralStopPrice(position, candles);

    if (this.isPriceBeyondStop(position, currentPrice, stopPrice)) {
      return this.closeManagedPositionAtMarket(position, currentPrice, 'SL');
    }

    const replacement = await this.replaceManagedStopLoss(position, stopPrice);
    position.stopOrderId = replacement.orderId || position.stopOrderId;
    position.stopPrice = Number(replacement.order?.stopPrice || stopPrice);
    position.sl = stopPrice;
    position.initialStopPrice = stopPrice;
    position.initialRisk = Math.abs(Number(position.entryPrice) - stopPrice);
    position.profitLockPrice = this.calculateGrossProfitLockPrice(position);
    position.takeProfitPrice = position.profitLockPrice;
    position.tp = position.profitLockPrice;
    position.followStage = 'PROFIT_TARGET';
    TradeSnapshotService.recordProtection?.(position.entryOrderId, {
      structuralStopPrice: position.stopPrice,
      structuralStopPercent: (Math.abs(Number(position.entryPrice) - Number(position.stopPrice)) / Number(position.entryPrice)) * 100,
      takeProfitPrice: position.takeProfitPrice
    });

    const protectionResult = await this.ensureProtectionOrdersWithRecovery(
      position,
      'DELAYED_PROTECTION_SETUP_FAILED'
    );
    if (protectionResult?.closed) {
      return protectionResult;
    }

    if (protectionResult?.protected && !position.protectionActivationNotificationSent) {
      position.protectionActivationNotificationSent = true;
      await NotificationService.sendProtectionActivated(position.coin, {
        signal: position.signal,
        entryPrice: position.entryPrice,
        delayMs: Math.max(0, Number(position.protectionActivationAt) - Number(position.enteredAt)),
        stopPrice: position.stopPrice,
        profitLockPrice: position.profitLockPrice,
        interval,
        lookback
      });
    }

    return { closed: false, protected: true };
  }

  resolveEntryPrice(orderResult, fallbackPrice) {
    const order = orderResult?.order;
    const avgPrice = Number(order?.avgPrice || order?.raw?.avgPrice || 0);
    if (Number.isFinite(avgPrice) && avgPrice > 0) {
      return avgPrice;
    }

    const executedQty = Number(order?.executedQty || order?.raw?.executedQty || 0);
    const cumQuote = Number(order?.raw?.cumQuote || order?.raw?.cumQuoteQty || 0);
    if (executedQty > 0 && cumQuote > 0) {
      return cumQuote / executedQty;
    }

    return Number(fallbackPrice);
  }

  async ensureProtectionOrders(position) {
    if (!Number.isFinite(Number(position.stopPrice)) || Number(position.stopPrice) <= 0) {
      throw new Error('PROTECTION_STOP_PRICE_INVALID');
    }
    const protectionSide = this.getProtectionSide(position.signal);
    const openOrders = await this.orderService.getOpenOrders(position.coin);
    const stopOrders = openOrders.filter(
      (order) => order.side === protectionSide && order.type === ORDER_TYPE.STOP_MARKET
    );
    const takeProfitOrders = openOrders.filter(
      (order) => order.side === protectionSide && order.type === ORDER_TYPE.TAKE_PROFIT_MARKET
    );
    const requireTakeProfit = position.delayedProtectionEnabled !== true && position.followStage === 'INITIAL';

    const stopOrder = await this.keepSingleOrder(stopOrders, position.coin);
    const takeProfitOrder = await this.keepSingleOrder(takeProfitOrders, position.coin);

    let activeStopOrder = stopOrder;
    let activeTakeProfitOrder = takeProfitOrder;

    if (!activeStopOrder) {
      const createdStop = await this.orderService.createStopLossOrder({
        symbol: position.coin,
        side: protectionSide,
        stopPrice: position.stopPrice,
        quantity: position.quantity
      });
      activeStopOrder = createdStop.order;
    }

    if (requireTakeProfit && !activeTakeProfitOrder) {
      const createdTakeProfit = await this.orderService.createTakeProfitOrder({
        symbol: position.coin,
        side: protectionSide,
        stopPrice: position.takeProfitPrice,
        quantity: position.quantity
      });
      activeTakeProfitOrder = createdTakeProfit.order;
    }

    if (!requireTakeProfit && activeTakeProfitOrder) {
      await this.orderService.cancelOrder(activeTakeProfitOrder.id, position.coin);
      activeTakeProfitOrder = null;
    }

    position.stopOrderId = activeStopOrder?.id || position.stopOrderId;
    position.takeProfitOrderId = requireTakeProfit
      ? activeTakeProfitOrder?.id || position.takeProfitOrderId
      : activeTakeProfitOrder?.id || null;
    position.stopPrice = Number(activeStopOrder?.stopPrice || position.stopPrice);
    position.sl = position.stopPrice;

    // A recovered/existing stop may have been created by an older build with a
    // much wider emergency/structural distance. Tighten it to today's hard cap.
    if (['PROTECTION_DELAY', 'INITIAL', 'PROFIT_TARGET'].includes(position.followStage)) {
      const hardCappedStop = this.applyInitialStopSafetyCap(
        position.entryPrice,
        position.signal,
        position.stopPrice
      );
      if (this.isStopImprovement(position, hardCappedStop)) {
        const tightenedStop = await this.replaceManagedStopLoss(position, hardCappedStop);
        position.stopOrderId = tightenedStop.orderId || position.stopOrderId;
        position.stopPrice = Number(tightenedStop.order?.stopPrice || hardCappedStop);
        position.sl = position.stopPrice;
        activeStopOrder = tightenedStop.order || activeStopOrder;
      }
    }

    position.takeProfitPrice = requireTakeProfit
      ? Number(activeTakeProfitOrder?.stopPrice || position.takeProfitPrice)
      : activeTakeProfitOrder?.stopPrice != null
        ? Number(activeTakeProfitOrder.stopPrice)
        : position.takeProfitPrice;
    position.tp = position.takeProfitPrice;
    this.protectionFailureCounts.delete(position.coin);
  }

  async ensureProtectionOrdersWithRecovery(position, errorType) {
    try {
      await this.ensureProtectionOrders(position);
      return { closed: false, protected: true, recovered: false };
    } catch (error) {
      return this.recoverProtectionOrders(position, error, errorType);
    }
  }

  async recoverProtectionOrders(position, initialError, errorType) {
    let lastError = initialError;

    for (const backoffMs of PROTECTION_RETRY_DELAYS_MS) {
      const protectionSnapshot = await this.readProtectionRecoverySnapshot(position);
      if (protectionSnapshot.protected) {
        this.syncProtectionStateFromSnapshot(position, protectionSnapshot);
        return { closed: false, protected: true, recovered: true };
      }

      logger.warn('Protection setup retry scheduled', {
        coin: position.coin,
        errorType,
        error: lastError.message,
        backoffMs
      });

      await this.delay(backoffMs);

      try {
        await this.ensureProtectionOrders(position);
        return { closed: false, protected: true, recovered: true };
      } catch (error) {
        lastError = error;
      }
    }

    const finalSnapshot = await this.readProtectionRecoverySnapshot(position);
    if (finalSnapshot.protected) {
      this.syncProtectionStateFromSnapshot(position, finalSnapshot);
      return { closed: false, protected: true, recovered: true };
    }

    return this.handleProtectionFailure(position, lastError, errorType);
  }

  async readProtectionRecoverySnapshot(position) {
    const livePosition = this.orderService.isLiveTradingEnabled()
      ? await this.orderService.getOpenPosition(position.coin)
      : null;
    const openOrders = await this.orderService.getOpenOrders(position.coin);
    const protectionSide = this.getProtectionSide(position.signal);
    const stopOrder = this.getLatestOrder(
      openOrders.filter((order) => order.side === protectionSide && order.type === ORDER_TYPE.STOP_MARKET)
    );
    const takeProfitOrder = this.getLatestOrder(
      openOrders.filter((order) => order.side === protectionSide && order.type === ORDER_TYPE.TAKE_PROFIT_MARKET)
    );

    return {
      livePosition,
      stopOrder,
      takeProfitOrder,
      protected: Boolean(stopOrder && (position.followStage === 'INITIAL' ? takeProfitOrder : true))
    };
  }

  syncProtectionStateFromSnapshot(position, snapshot) {
    if (snapshot.livePosition) {
      position.quantity = Number(snapshot.livePosition.quantity || position.quantity);
      position.entryPrice = Number(snapshot.livePosition.entryPrice || position.entryPrice);
      position.leverage = Number(snapshot.livePosition.leverage || position.leverage);

      const syncedTradeSizeUsdt = Math.abs(Number(snapshot.livePosition.notional || 0))
        / Math.max(Number(snapshot.livePosition.leverage || position.leverage || 1), 1);
      if (Number.isFinite(syncedTradeSizeUsdt) && syncedTradeSizeUsdt > 0) {
        position.tradeSizeUsdt = syncedTradeSizeUsdt;
      }
    }

    if (snapshot.stopOrder) {
      position.stopOrderId = snapshot.stopOrder.id;
      position.stopPrice = Number(snapshot.stopOrder.stopPrice || position.stopPrice);
      position.sl = position.stopPrice;
    }

    if (snapshot.takeProfitOrder) {
      position.takeProfitOrderId = snapshot.takeProfitOrder.id;
      position.takeProfitPrice = Number(snapshot.takeProfitOrder.stopPrice || position.takeProfitPrice);
      position.tp = position.takeProfitPrice;
    }
    this.protectionFailureCounts.delete(position.coin);
  }

  isTransientProtectionError(error) {
    const message = String(error?.message || '').toLowerCase();
    const status = Number(error?.response?.status || 0);
    const code = String(error?.code || '').toUpperCase();

    return (
      status === 400 ||
      status === 429 ||
      (status >= 500 && status < 600) ||
      code === 'ECONNRESET' ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('network error') ||
      message.includes('rest request failed') ||
      message.includes('websocket disconnected')
    );
  }

  async keepSingleOrder(orders, symbol) {
    if (!orders || orders.length === 0) {
      return null;
    }

    const sortedOrders = [...orders].sort((left, right) => this.getOrderTimestamp(right) - this.getOrderTimestamp(left));
    const primaryOrder = sortedOrders[0];
    const duplicateOrders = sortedOrders.slice(1);

    for (const duplicateOrder of duplicateOrders) {
      await this.orderService.cancelOrder(duplicateOrder.id, symbol);
    }

    return primaryOrder;
  }

  getLatestOrder(orders) {
    if (!orders || orders.length === 0) {
      return null;
    }

    return [...orders].sort((left, right) => this.getOrderTimestamp(right) - this.getOrderTimestamp(left))[0];
  }

  getOrderTimestamp(order) {
    const updatedAt = order.updatedAt instanceof Date ? order.updatedAt.getTime() : 0;
    const createdAt = order.createdAt instanceof Date ? order.createdAt.getTime() : 0;
    return Math.max(updatedAt, createdAt, 0);
  }

  getProtectionSide(signal) {
    return signal === 'BUY' ? 'SELL' : 'BUY';
  }

  calculateFavorableMovePercent(position, currentPrice) {
    const price = Number(currentPrice);
    if (position.signal === 'BUY') {
      return ((price - position.entryPrice) / position.entryPrice) * 100;
    }
    return ((position.entryPrice - price) / position.entryPrice) * 100;
  }

  async replaceManagedStopLoss(position, nextStopPrice, currentPriceOverride = null) {
    if (!this.isPositionBotManaged(position)) {
      const error = new Error('Stop-loss replacement blocked: ownership is not BOT_CONFIRMED');
      error.code = 'POSITION_OWNERSHIP_UNVERIFIED';
      throw error;
    }

    const normalizedStopPrice = this.normalizeStructuralStopPrice(position, nextStopPrice);
    const hasPriceMetadata = (Number.isFinite(Number(position?.tickSize)) && Number(position.tickSize) > 0)
      || (position?.pricePrecision != null && Number.isInteger(Number(position.pricePrecision)));
    const minimumChange = hasPriceMetadata
      ? Math.max(this.resolvePriceStep(position) * Number(config.STOP_UPDATE_MIN_TICKS), EPSILON)
      : EPSILON;
    const currentStopPrice = Number(position.stopPrice);
    const improvementDistance = position.signal === 'BUY'
      ? normalizedStopPrice - currentStopPrice
      : currentStopPrice - normalizedStopPrice;
    const improvesEnough = position.signal === 'BUY'
      ? normalizedStopPrice - currentStopPrice >= minimumChange
      : currentStopPrice - normalizedStopPrice >= minimumChange;
    const cooldownBlocksMinorUpdate = hasPriceMetadata
      && Number.isFinite(Number(position.lastStopUpdateAt))
      && Date.now() - Number(position.lastStopUpdateAt) < Number(config.STOP_UPDATE_COOLDOWN_MS)
      && improvementDistance < minimumChange * 2;
    if (!improvesEnough || cooldownBlocksMinorUpdate) {
      return {
        success: true,
        orderId: position.stopOrderId,
        order: { id: position.stopOrderId, stopPrice: currentStopPrice },
        noOp: true
      };
    }
    const immediateTriggerBlockUntil = Number(position.stopImmediateTriggerBlockUntil || 0);
    if (Date.now() < immediateTriggerBlockUntil) {
      return {
        success: true,
        orderId: position.stopOrderId,
        order: { id: position.stopOrderId, stopPrice: currentStopPrice },
        noOp: true,
        reason: 'BINANCE_IMMEDIATE_TRIGGER_COOLDOWN'
      };
    }

    // Prevent sending a stop that the market has already crossed. This is the
    // exact failure mode that previously caused repeated Binance -2021 errors
    // and false Telegram "Fiyat Revize Edildi" messages on SHORT positions.
    let referenceCurrentPrice = Number(currentPriceOverride);
    if ((!Number.isFinite(referenceCurrentPrice) || referenceCurrentPrice <= 0)
      && this.orderService.isLiveTradingEnabled?.()) {
      try {
        referenceCurrentPrice = Number(await this.orderService.getCurrentPrice(position.coin));
      } catch (error) {
        logger.warn('Stop preflight current-price lookup failed; stop update blocked fail-closed', {
          coin: position.coin,
          signal: position.signal,
          error: error.message
        });
        return {
          success: true,
          orderId: position.stopOrderId,
          order: { id: position.stopOrderId, stopPrice: currentStopPrice },
          noOp: true,
          reason: 'STOP_PREFLIGHT_PRICE_UNAVAILABLE'
        };
      }
    }
    if (Number.isFinite(referenceCurrentPrice) && referenceCurrentPrice > 0
      && this.isPriceBeyondStop(position, referenceCurrentPrice, normalizedStopPrice)) {
      logger.warn('Stop update blocked because market already crossed requested stop', {
        coin: position.coin,
        signal: position.signal,
        currentPrice: referenceCurrentPrice,
        requestedStopPrice: normalizedStopPrice,
        currentStopPrice
      });
      return {
        success: true,
        orderId: position.stopOrderId,
        order: { id: position.stopOrderId, stopPrice: currentStopPrice },
        noOp: true,
        reason: 'STOP_PREFLIGHT_WOULD_IMMEDIATELY_TRIGGER'
      };
    }

    try {
      const result = await this.orderService.replaceStopLoss({
        symbol: position.coin,
        cancelOrderId: position.stopOrderId,
        side: this.getProtectionSide(position.signal),
        stopPrice: normalizedStopPrice,
        quantity: position.quantity
      });
      if (!result?.noOp) position.lastStopUpdateAt = Date.now();
      return result;
    } catch (error) {
      if (error?.rollbackRestored && error.rollbackResult?.orderId) {
        position.stopOrderId = error.rollbackResult.orderId;
        position.stopPrice = Number(error.rollbackResult.order?.stopPrice || error.previousStopPrice);
        position.sl = position.stopPrice;
      }

      const binanceCode = Number(
        error?.response?.data?.code ??
        error?.responseData?.code ??
        error?.code
      );

      const binanceMessage = String(
        error?.response?.data?.msg ??
        error?.responseData?.msg ??
        error?.message ??
        ''
      );

      if (
        binanceCode === -2021 ||
        binanceMessage.includes('Order would immediately trigger')
      ) {
        position.stopImmediateTriggerBlockUntil = Date.now() + 15000;

        logger.warn('Stop-loss replacement hit Binance immediate-trigger guard; retry paused', {
          coin: position.coin,
          signal: position.signal,
          requestedStopPrice: normalizedStopPrice,
          restoredStopPrice: position.stopPrice,
          blockMs: 15000,
          reason: 'BINANCE_-2021_COOLDOWN'
        });

        return {
          success: true,
          orderId: position.stopOrderId,
          order: { id: position.stopOrderId, stopPrice: position.stopPrice },
          noOp: true,
          reason: 'BINANCE_IMMEDIATE_TRIGGER_COOLDOWN'
        };
      }

      throw error;
    }
  }

  async activateBreakEven(position) {
    const nextStopPrice = this.calculateBreakEvenStop(position);
    if (!this.isStopImprovement(position, nextStopPrice)) {
      position.breakEvenActivated = true;
      position.followStage = 'BREAK_EVEN';
      if (!position.breakEvenNotificationSent) {
        position.breakEvenNotificationSent = true;
        await NotificationService.sendBreakEven(position.coin, position.stopPrice, {
          signal: position.signal,
          triggerPercent: position.beTriggerPercent,
          stopAdjusted: false
        });
      }
      return;
    }

    const replacement = await this.replaceManagedStopLoss(position, nextStopPrice);
    if (replacement?.noOp) return;

    position.breakEvenActivated = true;
    position.followStage = 'BREAK_EVEN';
    position.stopOrderId = replacement.orderId;
    position.stopPrice = Number(replacement.order?.stopPrice || nextStopPrice);
    position.sl = position.stopPrice;

    if (!position.breakEvenNotificationSent) {
      position.breakEvenNotificationSent = true;
      await NotificationService.sendBreakEven(position.coin, position.stopPrice, {
        signal: position.signal,
        triggerPercent: position.beTriggerPercent,
        stopAdjusted: true
      });
    }
  }

  async updateDynamicTakeProfit(position, currentPrice, recentCandles, atrValueOverride = null) {
    const atrPeriod = this.resolveAtrPeriod();
    const atrValue = Number.isFinite(atrValueOverride) && atrValueOverride > 0
      ? atrValueOverride
      : this.calculateAtrValue(recentCandles, atrPeriod);
    if (!Number.isFinite(atrValue) || atrValue <= 0) {
      return;
    }

    const tpStepAtrMultiplier = this.getPositiveConfigNumber('TP_STEP_ATR_MULTIPLIER', DEFAULT_TP_STEP_ATR_MULTIPLIER);
    const minTpStepPercent = this.getPositiveConfigNumber('MIN_TP_STEP_PERCENT', DEFAULT_MIN_TP_STEP_PERCENT);
    const stepFromAtr = atrValue * tpStepAtrMultiplier;
    const minStepFromPercent = Number(position.entryPrice) * (minTpStepPercent / 100);
    const step = Math.max(stepFromAtr, minStepFromPercent);

    if (!Number.isFinite(step) || step <= 0) {
      return;
    }

    const nextTakeProfit = position.signal === 'BUY'
      ? Number(currentPrice) + step
      : Number(currentPrice) - step;
    if (!this.isTakeProfitImprovement(position, nextTakeProfit)) {
      return;
    }

    const replacement = await this.orderService.replaceTakeProfit({
      symbol: position.coin,
      cancelOrderId: position.takeProfitOrderId,
      side: this.getProtectionSide(position.signal),
      stopPrice: nextTakeProfit,
      quantity: position.quantity
    });

    position.takeProfitOrderId = replacement.orderId;
    position.takeProfitPrice = Number(replacement.order?.stopPrice || nextTakeProfit);
    position.tp = position.takeProfitPrice;
    await NotificationService.sendTakeProfitUpdate(position.coin, position.takeProfitPrice, {
      signal: position.signal,
      reason: 'ATR_DYNAMIC_TP'
    });
  }

  async updateTrailingStop(position, currentPrice, recentCandles, atrValueOverride = null) {
    const atrPeriod = this.resolveAtrPeriod();
    const atrValue = Number.isFinite(atrValueOverride) && atrValueOverride > 0
      ? atrValueOverride
      : this.calculateAtrValue(recentCandles, atrPeriod);
    if (!Number.isFinite(atrValue) || atrValue <= 0) {
      return;
    }

    const nextStopPrice = position.signal === 'BUY'
      ? currentPrice - (atrValue * position.trailingAtrMultiplier)
      : currentPrice + (atrValue * position.trailingAtrMultiplier);

    if (!position.trailingActivationNotificationSent) {
      position.trailingActivationNotificationSent = true;
      await NotificationService.sendTrailingActivated(position.coin, {
        signal: position.signal,
        currentStop: position.stopPrice
      });
    }

    if (!this.isStopImprovement(position, nextStopPrice)) {
      return;
    }

    const replacement = await this.replaceManagedStopLoss(position, nextStopPrice, currentPrice);
    if (replacement?.noOp) return;

    position.trailingActivated = true;
    position.stopOrderId = replacement.orderId;
    position.stopPrice = Number(replacement.order?.stopPrice || nextStopPrice);
    position.sl = position.stopPrice;

    await NotificationService.sendStopUpdate(position.coin, position.stopPrice, {
      signal: position.signal,
      reason: 'ATR_TRAILING'
    });
  }

  getPositionFollowMode() {
    return String(config.POSITION_FOLLOW_MODE || DEFAULT_POSITION_FOLLOW_MODE).trim().toUpperCase();
  }

  updatePositionExtremes(position, currentPrice) {
    const price = Number(currentPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    position.highestPriceSinceEntry = Math.max(Number(position.highestPriceSinceEntry || position.entryPrice), price);
    position.lowestPriceSinceEntry = Math.min(Number(position.lowestPriceSinceEntry || position.entryPrice), price);
  }

  calculateFavorableMoveR(position) {
    const risk = Number(position.initialRisk)
      || Math.abs(Number(position.entryPrice) - Number(position.initialStopPrice));
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const extreme = position.signal === 'BUY'
      ? Number(position.highestPriceSinceEntry)
      : Number(position.lowestPriceSinceEntry);
    const move = position.signal === 'BUY'
      ? extreme - Number(position.entryPrice)
      : Number(position.entryPrice) - extreme;
    return move / risk;
  }

  calculateRStopPrice(position, stopR) {
    const distance = Number(position.initialRisk) * Number(stopR);
    return position.signal === 'BUY'
      ? Number(position.entryPrice) + distance
      : Number(position.entryPrice) - distance;
  }

  recoverStagedFollowState(position) {
    if (this.getPositionFollowMode() !== 'STAGED_R_ATR') return position;
    if (position.delayedProtectionEnabled) return position;
    const risk = Number(position.initialRisk);
    if (!Number.isFinite(risk) || risk <= 0) return position;
    const lockedR = position.signal === 'BUY'
      ? (Number(position.stopPrice) - Number(position.entryPrice)) / risk
      : (Number(position.entryPrice) - Number(position.stopPrice)) / risk;
    const stage1StopR = this.getPositiveConfigNumber('PROFIT_LOCK_STAGE_1_STOP_R', 0.25);
    const stage2StopR = this.getPositiveConfigNumber('PROFIT_LOCK_STAGE_2_STOP_R', 0.5);
    if (lockedR >= stage2StopR - EPSILON) {
      position.followStage = lockedR > stage2StopR + EPSILON ? 'TRAILING' : 'PROFIT_LOCK_2';
      position.breakEvenActivated = true;
      position.trailingActivationReached = true;
      position.trailingActivated = position.followStage === 'TRAILING';
    } else if (lockedR >= stage1StopR - EPSILON) {
      position.followStage = 'PROFIT_LOCK_1';
      position.breakEvenActivated = true;
    }
    return position;
  }

  async activateProfitLock(position, stage, stopR, currentPrice = null) {
    const nextStopPrice = this.calculateRStopPrice(position, stopR);
    let stopChanged = false;
    if (this.isStopImprovement(position, nextStopPrice)) {
      const replacement = await this.replaceManagedStopLoss(position, nextStopPrice, currentPrice);
      if (replacement?.noOp) return false;
      position.stopOrderId = replacement.orderId;
      position.stopPrice = Number(replacement.order?.stopPrice || nextStopPrice);
      position.sl = position.stopPrice;
      stopChanged = true;
    }
    position.breakEvenActivated = true;
    position.followStage = stage;
    if (stopChanged) {
      await NotificationService.sendStopUpdate(position.coin, position.stopPrice, {
        signal: position.signal,
        reason: stage
      });
    }
    if (position.takeProfitOrderId) {
      try {
        await this.orderService.cancelOrder(position.takeProfitOrderId, position.coin);
        position.takeProfitOrderId = null;
      } catch (error) {
        logger.warn('Temporary safety take-profit cancellation failed; retrying next cycle', {
          coin: position.coin,
          error: error.message
        });
      }
    }
  }

  resolveRegimeTrailingMultiplier(position) {
    const expected = position.signal === 'BUY' ? TREND_TYPE.UP : TREND_TYPE.DOWN;
    const btcAligned = position.btcTrend === expected;
    const ethAligned = position.ethTrend === expected;
    if (btcAligned && ethAligned) {
      return this.getPositiveConfigNumber('TRAILING_ATR_STRONG_TREND_MULTIPLIER', 2.25);
    }
    if (position.btcTrend && position.ethTrend && btcAligned !== ethAligned) {
      return this.getPositiveConfigNumber('TRAILING_ATR_WEAK_TREND_MULTIPLIER', 1.25);
    }
    return this.getPositiveConfigNumber('TRAILING_ATR_NORMAL_MULTIPLIER', 1.75);
  }

  async activateGrossProfitLock(position) {
    const nextStopPrice = Number(position.profitLockPrice);
    if (!Number.isFinite(nextStopPrice) || nextStopPrice <= 0) {
      throw new Error('PROFIT_LOCK_PRICE_INVALID');
    }

    let stopChanged = false;
    if (this.isStopImprovement(position, nextStopPrice)) {
      const replacement = await this.replaceManagedStopLoss(position, nextStopPrice);
      if (replacement?.noOp) return false;
      position.stopOrderId = replacement.orderId;
      position.stopPrice = Number(replacement.order?.stopPrice || nextStopPrice);
      position.sl = position.stopPrice;
      stopChanged = true;
    }
    position.breakEvenActivated = true;
    position.trailingActivationReached = true;
    position.followStage = 'PROFIT_LOCKED';
    if (stopChanged) {
      await NotificationService.sendStopUpdate(position.coin, position.stopPrice, {
        signal: position.signal,
        reason: 'GROSS_PROFIT_LOCK'
      });
    }
  }

  async applyDelayedPositionFollow(position, currentPrice, recentCandles, atrValueOverride = null) {
    const currentMovePercent = this.calculateFavorableMovePercent(position, currentPrice);
    if (!Number.isFinite(currentMovePercent) || currentMovePercent <= 0) return;
    await this.enforcePercentProfitFloor(position, currentPrice);
    const target = Number(position.profitLockPrice);
    const favorableExtreme = position.signal === 'BUY'
      ? Number(position.highestPriceSinceEntry)
      : Number(position.lowestPriceSinceEntry);
    const targetReached = position.signal === 'BUY'
      ? favorableExtreme >= target
      : favorableExtreme <= target;

    if (config.ENABLE_BREAK_EVEN && position.followStage === 'PROFIT_TARGET'
      && Number.isFinite(target) && targetReached) {
      await this.activateGrossProfitLock(position);
    }

    if (!config.ENABLE_TRAILING_STOP || !['PROFIT_LOCKED', 'WIDE_TRAILING', 'TRAILING'].includes(position.followStage)) {
      return;
    }

    const atrValue = Number.isFinite(Number(atrValueOverride)) && Number(atrValueOverride) > 0
      ? Number(atrValueOverride)
      : this.calculateAtrValue(recentCandles, this.resolveAtrPeriod());
    if (!Number.isFinite(atrValue) || atrValue <= 0) return;

    const favorableR = this.calculateFavorableMoveR(position);
    const tighteningThresholdR = this.getPositiveConfigNumber('DELAYED_TRAILING_TIGHTEN_R_MULTIPLIER', 1.5);
    const isWideStage = position.followStage === 'PROFIT_LOCKED';
    const shouldTighten = !isWideStage && Number.isFinite(favorableR) && favorableR >= tighteningThresholdR;
    const multiplier = shouldTighten
      ? this.resolveRegimeTrailingMultiplier(position)
      : this.getPositiveConfigNumber('DELAYED_TRAILING_INITIAL_ATR_MULTIPLIER', 2.5);
    const referencePrice = position.signal === 'BUY'
      ? Number(position.highestPriceSinceEntry)
      : Number(position.lowestPriceSinceEntry);
    const atrStopPrice = position.signal === 'BUY'
      ? referencePrice - (atrValue * multiplier)
      : referencePrice + (atrValue * multiplier);
    const nextStopPrice = position.signal === 'BUY'
      ? Math.max(atrStopPrice, target)
      : Math.min(atrStopPrice, target);

    if (!position.trailingActivationNotificationSent) {
      position.trailingActivationNotificationSent = true;
      await NotificationService.sendTrailingActivated(position.coin, {
        signal: position.signal,
        currentStop: position.stopPrice
      });
    }
    if (isWideStage) position.followStage = 'WIDE_TRAILING';
    if (!this.isStopImprovement(position, nextStopPrice)) return;

    const replacement = await this.replaceManagedStopLoss(position, nextStopPrice, currentPrice);
    if (replacement?.noOp) return;
    position.trailingActivated = true;
    position.followStage = shouldTighten ? 'TRAILING' : 'WIDE_TRAILING';
    position.stopOrderId = replacement.orderId;
    position.stopPrice = Number(replacement.order?.stopPrice || nextStopPrice);
    position.sl = position.stopPrice;
    await NotificationService.sendStopUpdate(position.coin, position.stopPrice, {
      signal: position.signal,
      reason: shouldTighten ? 'STAGED_R_ATR_CHANDELIER' : 'STAGED_R_ATR_WIDE'
    });
  }

  async applyStagedPositionFollow(position, currentPrice, recentCandles, atrValueOverride = null) {
    if (position.delayedProtectionEnabled) {
      await this.applyDelayedPositionFollow(position, currentPrice, recentCandles, atrValueOverride);
      return;
    }
    const currentMovePercent = this.calculateFavorableMovePercent(position, currentPrice);
    if (!Number.isFinite(currentMovePercent) || currentMovePercent <= 0) return;
    await this.enforcePercentProfitFloor(position, currentPrice);
    const atrValue = Number.isFinite(Number(atrValueOverride)) && Number(atrValueOverride) > 0
      ? Number(atrValueOverride)
      : this.calculateAtrValue(recentCandles, this.resolveAtrPeriod());
    const favorableR = this.calculateFavorableMoveR(position);
    if (!Number.isFinite(favorableR)) return;

    const stage1TriggerR = this.getPositiveConfigNumber('PROFIT_LOCK_STAGE_1_TRIGGER_R', 0.75);
    const stage1StopR = this.getPositiveConfigNumber('PROFIT_LOCK_STAGE_1_STOP_R', 0.25);
    const stage2TriggerR = this.getPositiveConfigNumber('PROFIT_LOCK_STAGE_2_TRIGGER_R', 1);
    const stage2StopR = this.getPositiveConfigNumber('PROFIT_LOCK_STAGE_2_STOP_R', 0.5);
    if (config.ENABLE_BREAK_EVEN && position.followStage === 'INITIAL' && favorableR >= stage1TriggerR) {
      await this.activateProfitLock(position, 'PROFIT_LOCK_1', stage1StopR, currentPrice);
    }
    if (config.ENABLE_BREAK_EVEN && ['INITIAL', 'PROFIT_LOCK_1'].includes(position.followStage)
      && favorableR >= stage2TriggerR) {
      await this.activateProfitLock(position, 'PROFIT_LOCK_2', stage2StopR, currentPrice);
    }

    const activationR = stage2TriggerR;
    if (config.ENABLE_TRAILING_STOP && favorableR >= activationR
      && Number.isFinite(atrValue) && atrValue > 0) {
      position.trailingActivationReached = true;
      const multiplier = this.resolveRegimeTrailingMultiplier(position);
      const referencePrice = position.signal === 'BUY'
        ? Number(position.highestPriceSinceEntry)
        : Number(position.lowestPriceSinceEntry);
      const atrStopPrice = position.signal === 'BUY'
        ? referencePrice - (atrValue * multiplier)
        : referencePrice + (atrValue * multiplier);
      const profitFloor = this.calculateRStopPrice(position, stage2StopR);
      const nextStopPrice = position.signal === 'BUY'
        ? Math.max(atrStopPrice, profitFloor)
        : Math.min(atrStopPrice, profitFloor);
      if (!position.trailingActivationNotificationSent) {
        position.trailingActivationNotificationSent = true;
        await NotificationService.sendTrailingActivated(position.coin, {
          signal: position.signal,
          currentStop: position.stopPrice
        });
      }
      if (this.isStopImprovement(position, nextStopPrice)) {
        const replacement = await this.replaceManagedStopLoss(position, nextStopPrice, currentPrice);
        if (replacement?.noOp) return;
        position.trailingActivated = true;
        position.followStage = 'TRAILING';
        position.stopOrderId = replacement.orderId;
        position.stopPrice = Number(replacement.order?.stopPrice || nextStopPrice);
        position.sl = position.stopPrice;
        await NotificationService.sendStopUpdate(position.coin, position.stopPrice, {
          signal: position.signal,
          reason: 'STAGED_R_ATR_CHANDELIER'
        });
      }
    }
  }

  isStopImprovement(position, nextStopPrice) {
    if (!Number.isFinite(nextStopPrice)) {
      return false;
    }

    const normalized = this.normalizeStructuralStopPrice(position, nextStopPrice);
    const hasPriceMetadata = (Number.isFinite(Number(position?.tickSize)) && Number(position.tickSize) > 0)
      || (position?.pricePrecision != null && Number.isInteger(Number(position.pricePrecision)));
    const minimumChange = hasPriceMetadata
      ? this.resolvePriceStep(position) * Number(config.STOP_UPDATE_MIN_TICKS)
      : EPSILON;
    if (position.signal === 'BUY') {
      return normalized - Number(position.stopPrice) >= minimumChange;
    }

    return Number(position.stopPrice) - normalized >= minimumChange;
  }

  isTakeProfitImprovement(position, nextTakeProfitPrice) {
    if (!Number.isFinite(nextTakeProfitPrice)) {
      return false;
    }

    const currentTakeProfit = Number(position.takeProfitPrice);
    if (!Number.isFinite(currentTakeProfit)) {
      return true;
    }

    if (position.signal === 'BUY') {
      return nextTakeProfitPrice > currentTakeProfit + EPSILON;
    }

    return nextTakeProfitPrice < currentTakeProfit - EPSILON;
  }

  async resolveLiveCloseTruth(position, fallbackExitPrice) {
    if (!this.orderService.isLiveTradingEnabled?.() || typeof this.orderService.getUserTrades !== 'function') {
      return null;
    }

    const expectedExitSide = this.getProtectionSide(position.signal);
    const enteredAt = Number(position.enteredAt || 0);
    const startTime = enteredAt > 0 ? Math.max(0, enteredAt - 60000) : Date.now() - 24 * 60 * 60 * 1000;
    let trades;
    try {
      trades = await this.orderService.getUserTrades(position.coin, { startTime, limit: 1000 });
    } catch (error) {
      logger.warn('Live close truth lookup failed; economic finalization deferred', {
        coin: position.coin,
        error: error.message
      });
      return null;
    }

    const candidates = (trades || [])
      .filter((trade) => String(trade.side).toUpperCase() === expectedExitSide)
      .filter((trade) => Number(trade.time || 0) >= startTime)
      .filter((trade) => Number(trade.quantity || 0) > 0 && Number(trade.price || 0) > 0)
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0));

    if (candidates.length === 0) return null;

    const targetQuantity = Math.abs(Number(position.executedQuantity ?? position.quantity ?? 0));
    const selected = [];
    let selectedQty = 0;
    for (const trade of candidates) {
      selected.push(trade);
      selectedQty += Number(trade.quantity || 0);
      if (!Number.isFinite(targetQuantity) || targetQuantity <= 0 || selectedQty + EPSILON >= targetQuantity * 0.995) {
        break;
      }
    }
    if (Number.isFinite(targetQuantity) && targetQuantity > 0 && selectedQty + EPSILON < targetQuantity * 0.95) {
      logger.warn('Live close truth quantity is incomplete; economic finalization deferred', {
        coin: position.coin,
        targetQuantity,
        selectedQty
      });
      return null;
    }

    const quote = selected.reduce((sum, trade) => sum + Number(trade.price) * Number(trade.quantity), 0);
    const qty = selected.reduce((sum, trade) => sum + Number(trade.quantity), 0);
    const exitPrice = qty > 0 ? quote / qty : Number(fallbackExitPrice);
    const grossRealizedPnl = selected.reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0);
    const exitCommission = selected.reduce((sum, trade) => sum + Math.abs(Number(trade.commission || 0)), 0);

    const entryOrderId = position.entryOrderId != null ? String(position.entryOrderId) : null;
    const entrySide = String(position.signal || '').toUpperCase();
    let entryFills = entryOrderId
      ? (trades || []).filter((trade) => String(trade.orderId || '') === entryOrderId)
      : [];
    if (entryFills.length === 0) {
      const firstExitTime = selected.length ? Math.min(...selected.map((trade) => Number(trade.time || Infinity))) : Infinity;
      entryFills = (trades || [])
        .filter((trade) => String(trade.side || '').toUpperCase() === entrySide)
        .filter((trade) => Number(trade.time || 0) >= startTime && Number(trade.time || 0) <= firstExitTime);
    }
    const entryCommissionFromFills = entryFills.reduce((sum, trade) => sum + Math.abs(Number(trade.commission || 0)), 0);
    // Binance userTrades may be queried from just before enteredAt and can legitimately
    // omit the opening fill. In that case the position's recorded entry commission is
    // still part of the economic truth and must not be silently dropped.
    const recordedEntryCommission = Math.abs(Number(position.entryCommission || 0));
    const entryCommission = entryFills.length > 0
      ? entryCommissionFromFills
      : recordedEntryCommission;
    const netPnl = grossRealizedPnl - exitCommission - entryCommission;

    return {
      exitPrice,
      grossRealizedPnl,
      exitCommission,
      entryCommission,
      totalTradeCommission: entryCommission + exitCommission,
      netPnl,
      tradeIds: selected.map((trade) => trade.id).filter(Boolean),
      orderIds: [...new Set(selected.map((trade) => trade.orderId).filter(Boolean))],
      source: 'BINANCE_USER_TRADES'
    };
  }

  async finalizeLiveClosedPosition(position, fallbackExitPrice) {
    const stopOrder = await this.readOrderSnapshot(position.stopOrderId, position.coin);
    const takeProfitOrder = await this.readOrderSnapshot(position.takeProfitOrderId, position.coin);
    const filledOrder = selectFilledProtectiveOrder(
      [takeProfitOrder, stopOrder],
      ORDER_STATUS.FILLED
    );

    let liveTruth = null;
    if (this.orderService.isLiveTradingEnabled?.()) {
      liveTruth = await this.resolveLiveCloseTruth(position, fallbackExitPrice);
      // Never manufacture an economic close from mark/ticker fallback in LIVE.
      if (!liveTruth) {
        logger.warn('Live position disappeared but Binance fill truth is not available yet; retrying next monitor cycle', {
          coin: position.coin,
          fallbackExitPrice
        });
        return { closed: false, pendingCloseTruth: true };
      }
    }

    const exitPrice = liveTruth?.exitPrice
      ?? this.resolveOrderFillPrice(filledOrder, fallbackExitPrice, position);
    const closeReason = filledOrder
      ? this.determineCloseReason(position, filledOrder, exitPrice)
      : 'EXTERNAL_CLOSE';

    await this.cleanupRemainingProtectionOrders(position);

    return this.buildClosedPositionResult(
      position,
      exitPrice,
      closeReason,
      filledOrder?.id || liveTruth?.orderIds?.[0] || null,
      liveTruth ? { accountingTruth: liveTruth } : null
    );
  }

  async readOrderSnapshot(orderId, symbol) {
    if (!orderId) {
      return null;
    }

    try {
      return await this.orderService.getOrder(orderId, symbol);
    } catch (error) {
      logger.warn('Failed to fetch order snapshot', {
        orderId,
        symbol,
        error: error.message
      });
      return null;
    }
  }

  resolveOrderFillPrice(order, fallbackExitPrice, position) {
    const avgPrice = Number(order?.avgPrice || 0);
    if (Number.isFinite(avgPrice) && avgPrice > 0) {
      return avgPrice;
    }

    const stopPrice = Number(order?.stopPrice || 0);
    if (Number.isFinite(stopPrice) && stopPrice > 0) {
      return stopPrice;
    }

    if (order?.type === ORDER_TYPE.TAKE_PROFIT_MARKET) {
      return Number(position.takeProfitPrice);
    }

    if (order?.type === ORDER_TYPE.STOP_MARKET) {
      return Number(position.stopPrice);
    }

    return Number(fallbackExitPrice);
  }

  determineCloseReason(position, filledOrder, exitPrice) {
    if (filledOrder?.type === ORDER_TYPE.TAKE_PROFIT_MARKET) {
      return 'TP';
    }

    if (filledOrder?.type === ORDER_TYPE.STOP_MARKET) {
      if (position.trailingActivated && this.isProfitableStop(position, exitPrice)) {
        return 'TRAILING_TP';
      }

      if (position.breakEvenActivated && this.isNearBreakEven(position, exitPrice)) {
        return 'BE';
      }

      if (position.breakEvenActivated && this.isProfitableStop(position, exitPrice)) {
        return 'TRAILING_TP';
      }

      return 'SL';
    }

    if (position.signal === 'BUY') {
      if (exitPrice >= position.takeProfitPrice - EPSILON) {
        return 'TP';
      }
      if (position.breakEvenActivated && this.isNearBreakEven(position, exitPrice)) {
        return 'BE';
      }
      if (position.trailingActivated && exitPrice > position.entryPrice + EPSILON) {
        return 'TRAILING_TP';
      }
      return 'SL';
    }

    if (exitPrice <= position.takeProfitPrice + EPSILON) {
      return 'TP';
    }
    if (position.breakEvenActivated && this.isNearBreakEven(position, exitPrice)) {
      return 'BE';
    }
    if (position.trailingActivated && exitPrice < position.entryPrice - EPSILON) {
      return 'TRAILING_TP';
    }
    return 'SL';
  }

  isNearBreakEven(position, exitPrice) {
    const breakEvenPrice = this.calculateBreakEvenStop(position);
    const tolerance = this.calculateBreakEvenTolerance(position);
    return Math.abs(Number(exitPrice) - breakEvenPrice) <= tolerance;
  }

  resolvePriceStep(position) {
    const explicitTickSize = Number(position?.tickSize || position?.priceTickSize);
    if (Number.isFinite(explicitTickSize) && explicitTickSize > 0) {
      return explicitTickSize;
    }

    const precision = Number(position?.pricePrecision);
    if (Number.isInteger(precision) && precision >= 0 && precision <= 16) {
      return 10 ** (-precision);
    }

    const entryText = String(position?.entryPrice ?? '');
    const decimals = entryText.includes('.') ? entryText.split('.')[1].replace(/0+$/, '').length : 0;
    return decimals > 0 ? 10 ** (-Math.min(decimals, 16)) : 1;
  }

  calculateBreakEvenTolerance(position) {
    const priceStep = this.resolvePriceStep(position);
    const quantity = Number(position?.quantity);
    const notional = Number(position?.tradeSizeUsdt || 10);
    const commissionPerUnit = Number.isFinite(quantity) && quantity > 0
      ? (notional * this.commissionRate * 2) / quantity
      : 0;
    const precisionTolerance = Math.max(Number.EPSILON * Math.abs(Number(position?.entryPrice) || 1), 1e-12);

    return Math.max(priceStep, commissionPerUnit * 0.1, precisionTolerance);
  }

  isProfitableStop(position, exitPrice) {
    if (position.signal === 'BUY') {
      return Number(exitPrice) > Number(position.entryPrice) + EPSILON;
    }
    return Number(exitPrice) < Number(position.entryPrice) - EPSILON;
  }

  async cleanupRemainingProtectionOrders(position) {
    const openOrders = await this.orderService.getOpenOrders(position.coin);
    const orderIdsToCancel = new Set(
      [position.stopOrderId, position.takeProfitOrderId].filter(Boolean)
    );

    for (const order of openOrders) {
      if (orderIdsToCancel.has(order.id)) {
        await this.orderService.cancelOrder(order.id, position.coin);
      }
    }
  }

  buildClosedPositionResult(position, exitPrice, reason, exitOrderId = null, options = null) {
    const isLong = position.signal === 'BUY';
    const pnlPerUnit = isLong
      ? (exitPrice - position.entryPrice)
      : (position.entryPrice - exitPrice);
    const pnl = pnlPerUnit * (position.quantity || 1);
    const pnlPercent = (pnlPerUnit / position.entryPrice) * 100;
    const positionNotionalUsdt = (position.tradeSizeUsdt || 10);
    const calculatedPnlForTradeSizeUsdt = positionNotionalUsdt * (pnlPercent / 100);
    const accountingTruth = options?.accountingTruth || null;
    const pnlForTradeSizeUsdt = accountingTruth
      ? Number(accountingTruth.grossRealizedPnl)
      : calculatedPnlForTradeSizeUsdt;
    const exitCommission = accountingTruth
      ? Number(accountingTruth.exitCommission || 0)
      : positionNotionalUsdt * this.commissionRate;
    const totalTradeCommission = accountingTruth
      ? Number(accountingTruth.totalTradeCommission || 0)
      : (position.entryCommission || 0) + exitCommission;
    const netPnlForTradeSizeUsdt = accountingTruth
      ? Number(accountingTruth.netPnl)
      : pnlForTradeSizeUsdt - totalTradeCommission;
    const finalHighest = position.signal === 'BUY'
      ? Math.max(Number(position.highestPriceSinceEntry || position.entryPrice), Number(exitPrice))
      : Number(position.highestPriceSinceEntry || position.entryPrice);
    const finalLowest = position.signal === 'SELL'
      ? Math.min(Number(position.lowestPriceSinceEntry || position.entryPrice), Number(exitPrice))
      : Math.min(Number(position.lowestPriceSinceEntry || position.entryPrice), Number(exitPrice));
    const maxFavorableExcursionPercent = position.signal === 'BUY'
      ? ((finalHighest - Number(position.entryPrice)) / Number(position.entryPrice)) * 100
      : ((Number(position.entryPrice) - finalLowest) / Number(position.entryPrice)) * 100;
    const maxAdverseExcursionPercent = position.signal === 'BUY'
      ? ((finalLowest - Number(position.entryPrice)) / Number(position.entryPrice)) * 100
      : ((Number(position.entryPrice) - Math.max(Number(position.highestPriceSinceEntry || position.entryPrice), Number(exitPrice))) / Number(position.entryPrice)) * 100;
    const closeCorrelationId = randomUUID();

 this.tradeStats.total += 1;

/* Kapanış nedeni sayaçları */

if (reason === 'TP') {

    this.tradeStats.tp += 1;

    if (isLong) {
        this.tradeStats.tpLong += 1;
    } else {
        this.tradeStats.tpShort += 1;
    }

}
else if (reason === 'TRAILING_TP') {

    this.tradeStats.tp += 1;

    if (isLong) {
        this.tradeStats.trailLong += 1;
    } else {
        this.tradeStats.trailShort += 1;
    }

}
else if (reason === 'BE') {

    this.tradeStats.breakEven += 1;

    if (isLong) {
        this.tradeStats.beLong += 1;
    } else {
        this.tradeStats.beShort += 1;
    }

}
else if (reason === 'SL') {

    this.tradeStats.sl += 1;

    if (isLong) {
        this.tradeStats.slLong += 1;
    } else {
        this.tradeStats.slShort += 1;
    }

}
else {

    this.tradeStats.external += 1;

    if (isLong) {
        this.tradeStats.externalLong += 1;
    } else {
        this.tradeStats.externalShort += 1;
    }

}

/* Ekonomik sonuc yalniz komisyon sonrasi net PnL ile belirlenir.
 * Kapanis tetigi (TP/TRAIL/BE/SL/EXTERNAL_CLOSE) sonuc sinifi degildir. */

const economicOutcome = classifyEconomicOutcome(netPnlForTradeSizeUsdt);
if (economicOutcome === 'PROFIT') {

    this.tradeStats.successful += 1;

}
else if (economicOutcome === 'LOSS') {

    this.tradeStats.failed += 1;

}
else {

    this.tradeStats.neutral += 1;

}


    this.sessionStats.total += 1;
    if (economicOutcome === 'PROFIT') this.sessionStats.successful += 1;
    else if (economicOutcome === 'LOSS') this.sessionStats.failed += 1;
    else this.sessionStats.neutral += 1;
    this.sessionStats.netPnlUsdt += netPnlForTradeSizeUsdt;

    this.realizedPnlForTradeSizeUsdt += pnlForTradeSizeUsdt;
    this.totalCommissionUsdt += accountingTruth ? totalTradeCommission : exitCommission;
    this.paperWalletBalanceUsdt = this.paperWalletStartUsdt + this.realizedPnlForTradeSizeUsdt - this.totalCommissionUsdt;
    this.persistAccountingState();

    logger.info('Position Exit', {
      coin: position.coin,
      signal: position.signal,
      sessionId: position.sessionId || this.sessionId || null,
      reason,
      exitOrderId,
      exitPrice,
      pnl,
      pnlPercent,
      pnlForTradeSizeUsdt,
      netPnlForTradeSizeUsdt,
      economicOutcome,
      totalTradeCommission,
      exitCommission,
      accountingSource: accountingTruth?.source || 'BOT_CALCULATED',
      binanceTradeIds: accountingTruth?.tradeIds || [],
      targetRiskUsdt: position.targetRiskUsdt ?? null,
      plannedRiskUsdt: position.plannedRiskUsdt ?? null,
      executedRiskUsdt: position.executedRiskUsdt ?? null,
      structuralStopPercent: position.structuralStopPercent ?? null,
      executedNotionalUsdt: position.executedNotionalUsdt ?? positionNotionalUsdt,
      executedQuantity: position.executedQuantity ?? position.quantity,
      positionFollowMode: this.getPositionFollowMode(),
      followStage: position.followStage,
      maxFavorableExcursionPercent,
      maxAdverseExcursionPercent,
      paperWalletBalanceUsdt: this.paperWalletBalanceUsdt,
      stats: this.tradeStats
    });

    TradeSnapshotService.recordExit({
      tradeId: position.entryOrderId,
      sessionId: position.sessionId || this.sessionId || null,
      sessionStartedAt: position.sessionStartedAt ?? this.sessionStartedAt,
      symbol: position.coin,
      exitTime: Date.now(),
      exitPrice,
      exitType: reason === 'TRAILING_TP' ? 'TRAILING' : reason,
      grossPnl: pnlForTradeSizeUsdt,
      entryCommission: position.entryCommission || 0,
      exitCommission,
      totalTradeCommission,
      accountingSource: accountingTruth?.source || 'BOT_CALCULATED',
      binanceTradeIds: accountingTruth?.tradeIds || [],
      estimatedSlippagePercent: config.ESTIMATED_SLIPPAGE_PERCENT,
      netPnl: netPnlForTradeSizeUsdt,
      targetRiskUsdt: position.targetRiskUsdt ?? null,
      plannedRiskUsdt: position.plannedRiskUsdt ?? null,
      executedRiskUsdt: position.executedRiskUsdt ?? null,
      plannedStructuralStopPrice: position.plannedStructuralStopPrice ?? null,
      structuralStopPercent: position.structuralStopPercent ?? null,
      configuredMaxNotionalUsdt: position.configuredMaxNotionalUsdt ?? null,
      plannedNotionalUsdt: position.plannedNotionalUsdt ?? null,
      executedNotionalUsdt: position.executedNotionalUsdt ?? positionNotionalUsdt,
      requestedQuantity: position.requestedQuantity ?? null,
      executedQuantity: position.executedQuantity ?? position.quantity,
      positionFollowMode: this.getPositionFollowMode(),
      finalFollowStage: position.followStage,
      maxFavorableExcursionPercent,
      maxAdverseExcursionPercent,
      closeCorrelationId,
      turnoverUsdt: positionNotionalUsdt * 2
    });

    return {
      closed: true,
      notification: {
        coin: position.coin,
        signal: position.signal,
        entryPrice: position.entryPrice,
        exitPrice,
        reason,
        pnl,
        pnlPercent,
        pnlForTradeSizeUsdt,
        netPnlForTradeSizeUsdt,
        economicOutcome,
        totalTradeCommission,
        turnoverUsdt: positionNotionalUsdt * 2,
        maxFavorableExcursionPercent,
        maxAdverseExcursionPercent,
        closeCorrelationId,
        totalTradeCommission,
        exitCommission,
        accountingSource: accountingTruth?.source || 'BOT_CALCULATED',
        binanceTradeIds: accountingTruth?.tradeIds || [],
        closedAt: Date.now(),
        durationMs: Number.isFinite(Number(position.enteredAt)) ? Math.max(0, Date.now() - Number(position.enteredAt)) : null
      }
    };
  }

  async handleProtectionFailure(position, error, errorType) {
    if (this.isTransientProtectionError(error)) {
      logger.warn('Transient protection error detected, skipping this monitor cycle', {
        coin: position.coin,
        errorType,
        error: error.message
      });
      return null;
    }

    const failureCount = (this.protectionFailureCounts.get(position.coin) || 0) + 1;
    this.protectionFailureCounts.set(position.coin, failureCount);

    let protectionSnapshot = null;
    try {
      protectionSnapshot = await this.readProtectionRecoverySnapshot(position);
    } catch (snapshotError) {
      logger.warn('Failed to verify protection state before emergency close', {
        coin: position.coin,
        error: snapshotError.message
      });
      return null;
    }

    if (!protectionSnapshot.livePosition) {
      this.protectionFailureCounts.delete(position.coin);
      logger.warn('Position is not open anymore, emergency close skipped', {
        coin: position.coin,
        errorType
      });
      return null;
    }

    if (protectionSnapshot.protected) {
      this.syncProtectionStateFromSnapshot(position, protectionSnapshot);
      logger.warn('Protection already present, emergency close skipped', {
        coin: position.coin,
        errorType
      });
      return null;
    }

    if (failureCount < PROTECTION_EMERGENCY_CLOSE_MAX_FAILURES) {
      logger.warn('Protection missing, retry threshold not reached yet', {
        coin: position.coin,
        errorType,
        failureCount,
        maxFailures: PROTECTION_EMERGENCY_CLOSE_MAX_FAILURES
      });
      return null;
    }

    logger.error('Protection order failure', {
      coin: position.coin,
      errorType,
      error: error.message,
      failureCount,
      httpStatus: error.response?.status ?? null,
      binanceErrorCode: error.response?.data?.code ?? null,
      binanceErrorMessage: error.response?.data?.msg ?? error.message,
      endpoint: error.config?.url || null,
      requestId: error.response?.headers?.['x-request-id'] || error.response?.headers?.['x-mbx-uuid'] || null,
      orderType: null,
      stackTrace: error.stack || null
    });

    await NotificationService.sendMessage(
      `🚨 <b>Protection Failure Alarm</b>\n` +
      `Coin: <code>${position.coin}</code>\n` +
      `Tip: <code>${errorType}</code>\n` +
      `Mesaj: <code>${error.message}</code>\n` +
      `Protection kurulamadı, emergency close başlatılıyor.`
    );
    await NotificationService.sendError(errorType, `${position.coin}: ${error.message}`);

    if (!position.quantity) {
      return null;
    }

    try {
      const emergencyClose = await this.orderService.placeOrder({
        symbol: position.coin,
        side: this.getProtectionSide(position.signal),
        quantity: position.quantity,
        type: ORDER_TYPE.MARKET,
        reduceOnly: true
      });

      return this.buildClosedPositionResult(
        position,
        this.resolveEntryPrice(emergencyClose, position.entryPrice),
        'SL',
        emergencyClose.orderId
      );
    } catch (closeError) {
      logger.error('Emergency close failed', {
        coin: position.coin,
        error: closeError.message
      });
      await NotificationService.sendError('EMERGENCY_CLOSE_FAILED', `${position.coin}: ${closeError.message}`);
      return null;
    } finally {
      this.protectionFailureCounts.delete(position.coin);
    }
  }

  async syncLiveOpenPositionsOnStart(maxPositions) {
    const mode = (process.env.APP_MODE || 'paper').toLowerCase();
    if (mode !== 'live') {
      return;
    }

    try {
      const livePositions = await this.fetchLiveOpenPositions();
      if (livePositions.length === 0) {
        logger.info('No open live positions found on startup');
        return;
      }

      const limit = Math.max(1, maxPositions);
      const positionsToLoad = livePositions.slice(0, limit);
      for (const position of positionsToLoad) {
        if (!this.isPositionBotManaged(position)) {
          continue;
        }

        this.activePositions.set(position.coin, position);
      }

      logger.info('Live open positions synced on startup', {
        found: livePositions.length,
        loaded: positionsToLoad.length,
        maxPositions: limit
      });

      await NotificationService.sendMessage(
        `🔄 <b>Canlı Açık Pozisyon Senkronu</b>\n` +
        `Bulunan: <code>${livePositions.length}</code>\n` +
        `Yüklenen: <code>${this.activePositions.size}/${limit}</code>`
      );
    } catch (error) {
      logger.error('Failed to sync live open positions on startup', { error: error.message });
      await NotificationService.sendError('LIVE_POSITION_SYNC', error.message);
    }
  }

  async fetchLiveOpenPositions() {
    const livePositions = await this.orderService.getOpenPositions();
    const syncedPositions = [];

    for (const livePosition of livePositions) {
      let openOrders = [];
      try {
        openOrders = await this.orderService.getOpenOrders(livePosition.symbol);
      } catch (error) {
        logger.warn('Failed to fetch open orders during startup live position sync', {
          coin: livePosition.symbol,
          error: error.message
        });
      }

      const position = this.buildPositionStateFromLivePosition(livePosition, {
        ownership: 'UNMANAGED',
        openOrders
      });

      const ownership = await this.resolveLivePositionOwnership(livePosition, openOrders);
      if (!ownership.managed) {
        if (this.shouldLogOwnershipWarning(livePosition.symbol, ownership.reason)) {
          logger.warn('Startup live position skipped due to unverified ownership', {
            coin: livePosition.symbol,
            side: livePosition.side,
            reason: ownership.reason
          });
        }
        continue;
      }

      position.ownership = 'BOT_CONFIRMED';
      this.recoverStagedFollowState(position);

      const protectionResult = await this.ensureProtectionOrdersWithRecovery(
        position,
        'LIVE_POSITION_SYNC_PROTECTION_FAILED'
      );
      if (protectionResult?.closed) {
        continue;
      }

      position.breakEvenActivated = this.isBreakEvenActive(position);
      position.trailingActivated = position.breakEvenActivated && !this.isNearBreakEven(position, position.stopPrice);
      position.trailingActivationReached = position.trailingActivated;
      syncedPositions.push(position);
    }

    return syncedPositions;
  }

  isBreakEvenActive(position) {
    const breakEvenPrice = this.calculateBreakEvenStop(position);
    if (position.signal === 'BUY') {
      return Number(position.stopPrice) >= breakEvenPrice - EPSILON;
    }
    return Number(position.stopPrice) <= breakEvenPrice + EPSILON;
  }

  stop() {
    this.running = false;
    if (this.strategyLoopHandle) {
      clearTimeout(this.strategyLoopHandle);
      this.strategyLoopHandle = null;
    }
    if (this.ambushMonitorLoopHandle) {
      clearTimeout(this.ambushMonitorLoopHandle);
      this.ambushMonitorLoopHandle = null;
    }
    if (this.positionLoopHandle) {
      clearInterval(this.positionLoopHandle);
      this.positionLoopHandle = null;
    }
    if (this.performanceReportLoopHandle) {
      clearInterval(this.performanceReportLoopHandle);
      this.performanceReportLoopHandle = null;
    }
    logger.info('Trading loop stopped');
  }

  calculateAtrPercent(candles, period = this.resolveAtrPeriod()) {
    if (!Array.isArray(candles) || candles.length < 2) {
      return 0;
    }

    const effectivePeriod = Math.min(period, candles.length - 1);
    const window = candles.slice(-(effectivePeriod + 1));
    let trSum = 0;

    for (let i = 1; i < window.length; i++) {
      const current = window[i];
      const previous = window[i - 1];
      const high = Number(current.high);
      const low = Number(current.low);
      const prevClose = Number(previous.close);
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trSum += tr;
    }

    const atr = trSum / effectivePeriod;
    const lastClose = Number(window[window.length - 1].close);
    if (!Number.isFinite(lastClose) || lastClose <= 0) {
      return 0;
    }

    return (atr / lastClose) * 100;
  }

  calculateAtrValue(candles, period = this.resolveAtrPeriod()) {
    if (!Array.isArray(candles) || candles.length < 2) {
      return 0;
    }

    const effectivePeriod = Math.min(period, candles.length - 1);
    const window = candles.slice(-(effectivePeriod + 1));
    let trSum = 0;

    for (let i = 1; i < window.length; i++) {
      const current = window[i];
      const previous = window[i - 1];
      const high = Number(current.high);
      const low = Number(current.low);
      const prevClose = Number(previous.close);
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trSum += tr;
    }

    return trSum / effectivePeriod;
  }

  resolveAtrPeriod() {
    const parsed = Number(config.ATR_PERIOD);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATR_PERIOD;
  }

  getPositiveConfigNumber(key, fallbackValue) {
    const parsed = Number.parseFloat(String(config[key]));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
  }

  calculateBreakEvenTriggerPercent(position, atrValue, beAtrMultiplier = DEFAULT_BE_ATR_MULTIPLIER) {
    const entryPrice = Number(position?.entryPrice);
    const atr = Number(atrValue);
    const multiplier = Number(beAtrMultiplier);

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return null;
    }
    if (!Number.isFinite(atr) || atr <= 0) {
      return null;
    }
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      return null;
    }

    return ((atr * multiplier) / entryPrice) * 100;
  }

  calculateTrailingActivationPercent(position, atrValue) {
    const multiplier = Number(position?.trailingActivationAtrMultiplier)
      || this.getPositiveConfigNumber(
        'TRAILING_ACTIVATION_ATR_MULTIPLIER',
        DEFAULT_TRAILING_ACTIVATION_ATR_MULTIPLIER
      );
    return this.calculateBreakEvenTriggerPercent(position, atrValue, multiplier);
  }

  calculateBreakEvenStop(position) {
    const entryPrice = Number(position.entryPrice);
    const quantity = Number(position.quantity) || 0;
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      return entryPrice;
    }

    const positionNotionalUsdt = (position.tradeSizeUsdt || 10);
    const roundTripCommission = positionNotionalUsdt * this.commissionRate * 2;
    const commissionPerUnit = roundTripCommission / quantity;

    if (position.signal === 'BUY') {
      return entryPrice + commissionPerUnit;
    }

    return entryPrice - commissionPerUnit;
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  checkOneMinuteConfirmation(candles, expectedSignal, trend = null) {
    if (!Array.isArray(candles) || candles.length < this.trigger.period) {
      return { confirmed: false, reason: null };
    }

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const bb = this.trigger.calculateBollingerBands(candles);
    const lastPrice = this.trigger.getSourcePrice(last);
    const prevPrice = this.trigger.getSourcePrice(prev);

    const range = Math.max(Number(last.high) - Number(last.low), 1e-12);
    const bodyRatio = Math.abs(Number(last.close) - Number(last.open)) / range;
    const bodyThreshold = parseFloat(process.env.CONFIRMATION_BODY_RATIO || '0.55');
    const volumeMultiplier = parseFloat(process.env.CONFIRMATION_VOLUME_MULTIPLIER || '1.5');

    const bullishReversal = Number(last.close) > Number(last.open) && Number(prev.close) < Number(prev.open);
    const bearishReversal = Number(last.close) < Number(last.open) && Number(prev.close) > Number(prev.open);
    const strongReversal = expectedSignal === 'BUY'
      ? bullishReversal && bodyRatio >= bodyThreshold
      : bearishReversal && bodyRatio >= bodyThreshold;

    const returnedInsideBand = expectedSignal === 'BUY'
      ? prevPrice <= bb.lower && lastPrice > bb.lower
      : prevPrice >= bb.upper && lastPrice < bb.upper;

    const volumeSpikeBase = Number(prev.volume) > 0 ? Number(prev.volume) : 1;
    const volumeSpike = Number(last.volume) >= volumeSpikeBase * volumeMultiplier;
    const directionalCandle = expectedSignal === 'BUY'
      ? Number(last.close) > Number(last.open)
      : Number(last.close) < Number(last.open);
    const confirmedByVolume = volumeSpike && directionalCandle;
    const momentumAligned = expectedSignal === 'BUY'
      ? Number(last.close) > Number(prev.close)
      : Number(last.close) < Number(prev.close);
    const features = {
      strongReversal,
      returnedInsideBand,
      volumeSpike,
      directionalVolume: confirmedByVolume,
      momentumAligned
    };

    if (trend === TREND_TYPE.SIDEWAYS) {
      const period = Math.max(2, parseInt(process.env.RSI_PERIOD || '14', 10));
      const sidewaysAdxMin = parseFloat(process.env.SIDEWAYS_ADX_MIN || '18');
      if (candles.length < period + 2) {
        return { confirmed: false, reason: null };
      }

      const closes = candles.map((candle) => Number(candle.close));
      const computeRsi = (values) => {
        let gains = 0;
        let losses = 0;
        for (let i = values.length - period; i < values.length; i++) {
          const change = values[i] - values[i - 1];
          if (change > 0) gains += change;
          else losses += Math.abs(change);
        }
        if (losses === 0) return 100;
        const rs = (gains / period) / (losses / period);
        return 100 - (100 / (1 + rs));
      };

      const prevRsi = computeRsi(closes.slice(0, -1));
      const lastRsi = computeRsi(closes);
      const rsiOversold = parseFloat(process.env.RSI_OVERSOLD || '30');
      const rsiOverbought = parseFloat(process.env.RSI_OVERBOUGHT || '70');
      const rsiReversal = expectedSignal === 'BUY'
        ? prevRsi <= rsiOversold && lastRsi > prevRsi
        : prevRsi >= rsiOverbought && lastRsi < prevRsi;

      const adxPeriod = 14;
      let adx = 0;
      if (candles.length >= adxPeriod + 1) {
        const trueRanges = [];
        const plusDMs = [];
        const minusDMs = [];
        for (let i = 1; i < candles.length; i++) {
          const high = Number(candles[i].high);
          const low = Number(candles[i].low);
          const prevHigh = Number(candles[i - 1].high);
          const prevLow = Number(candles[i - 1].low);
          const prevClose = Number(candles[i - 1].close);
          const upMove = high - prevHigh;
          const downMove = prevLow - low;
          plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
          minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
          trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        let smoothedTR = trueRanges.slice(0, adxPeriod).reduce((sum, value) => sum + value, 0);
        let smoothedPlusDM = plusDMs.slice(0, adxPeriod).reduce((sum, value) => sum + value, 0);
        let smoothedMinusDM = minusDMs.slice(0, adxPeriod).reduce((sum, value) => sum + value, 0);
        const dxValues = [];
        const initialPlusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
        const initialMinusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
        const initialSumDI = initialPlusDI + initialMinusDI;
        dxValues.push(initialSumDI === 0 ? 0 : (Math.abs(initialPlusDI - initialMinusDI) / initialSumDI) * 100);
        for (let i = adxPeriod; i < trueRanges.length; i++) {
          smoothedTR = smoothedTR - (smoothedTR / adxPeriod) + trueRanges[i];
          smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / adxPeriod) + plusDMs[i];
          smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / adxPeriod) + minusDMs[i];
          const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
          const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
          const sumDI = plusDI + minusDI;
          dxValues.push(sumDI === 0 ? 0 : (Math.abs(plusDI - minusDI) / sumDI) * 100);
        }
        const adxWindow = dxValues.slice(-adxPeriod);
        adx = adxWindow.reduce((sum, value) => sum + value, 0) / Math.max(adxWindow.length, 1);
      }
      const adxFilterPassed = adx >= sidewaysAdxMin;

      const sidewaysConditions = [returnedInsideBand, rsiReversal, adxFilterPassed];
      if (hasRequiredConfirmations(sidewaysConditions)) {
        return { confirmed: true, reason: 'SIDEWAYS_TWO_OF_THREE_CONFIRMATION', features: { ...features, rsiReversal, adxFilterPassed } };
      }

      return { confirmed: false, reason: null, features: { ...features, rsiReversal, adxFilterPassed } };
    }

    if (
      config.REJECT_VOLUME_ONLY_CONFIRMATION === true
      && confirmedByVolume
      && !strongReversal
      && !returnedInsideBand
    ) {
      return {
        confirmed: false,
        reason: 'VOLUME_SPIKE_ONLY_REJECTED',
        reasons: [],
        features
      };
    }

    const reasons = [];
    if (strongReversal) reasons.push('STRONG_REVERSAL_CANDLE');
    if (returnedInsideBand && (strongReversal || confirmedByVolume || momentumAligned)) {
      reasons.push('RETURNED_INSIDE_BAND');
    }
    if (confirmedByVolume) reasons.push('VOLUME_SPIKE');
    if (reasons.length > 0) return { confirmed: true, reason: reasons.join('|'), reasons, features };

    return { confirmed: false, reason: null, reasons, features };
  }

  getPositionDirectionCounts() {
    let longCount = 0;
    let shortCount = 0;

    for (const position of this.activePositions.values()) {
      if (position.signal === 'BUY') {
        longCount += 1;
      } else if (position.signal === 'SELL') {
        shortCount += 1;
      }
    }

    return { longCount, shortCount };
  }

  getAmbushDirectionCounts() {
    let longCount = 0;
    let shortCount = 0;

    for (const ambush of this.ambushList.values()) {
      if (ambush.direction === 'BUY') {
        longCount += 1;
      } else if (ambush.direction === 'SELL') {
        shortCount += 1;
      }
    }

    return { longCount, shortCount };
  }
}

export default TradingLoop;
