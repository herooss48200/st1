import logger from '../services/logger.js';
import config from '../config/config.js';
import { TREND_TYPE } from '../shared/types/index.js';

function createCycleStats() {
  return {
    startedAt: Date.now(),
    coinsScanned: 0,
    similarityPassed: 0,
    similarityRejected: 0,
    bollingerChecks: 0,
    bollingerPassed: 0,
    confirmationChecks: 0,
    confirmationPassed: 0,
    riskRejected: 0,
    createdPositions: 0,
    trend: null,
    btcTrend: null,
    ethTrend: null,
    trendPassed: false,
    trendEvaluatedThisCycle: false,
    refreshPerformed: false,
    refreshStatus: null,
    refreshReason: null,
    nextRefreshInMs: null,
    recoveredTriggeredAmbushes: 0,
    readyAmbushes: 0,
    ambushesBefore: 0,
    ambushesAfter: 0
  };
}

function getEffectiveThreshold(trend) {
  return trend === TREND_TYPE.SIDEWAYS
    ? config.SIDEWAYS_SIMILARITY_THRESHOLD
    : config.SIMILARITY_THRESHOLD;
}

function getNextRefreshInMs(tradingLoop) {
  if (tradingLoop.lastAmbushRefreshAt == null) {
    return 0;
  }

  const resolvedFromLoop = typeof tradingLoop.resolveAmbushRefreshIntervalMs === 'function'
    ? Number(tradingLoop.resolveAmbushRefreshIntervalMs())
    : Number.NaN;
  const resolvedFromConfig = Number(config.AMBUSH_REFRESH_INTERVAL_MINUTES) * 60 * 1000;
  const refreshIntervalMs = Number.isFinite(resolvedFromLoop) && resolvedFromLoop > 0
    ? resolvedFromLoop
    : (Number.isFinite(resolvedFromConfig) && resolvedFromConfig > 0 ? resolvedFromConfig : 30 * 60 * 1000);

  const remaining = refreshIntervalMs - (Date.now() - tradingLoop.lastAmbushRefreshAt);
  if (!Number.isFinite(remaining)) {
    return 0;
  }

  return Math.max(0, remaining);
}

function evaluateTrendPass(tradingLoop, btcTrend, ethTrend) {
  if (typeof tradingLoop?.evaluateTrendAlignment === 'function') {
    return Boolean(tradingLoop.evaluateTrendAlignment(btcTrend, ethTrend)?.allowed);
  }

  const isUp = btcTrend === TREND_TYPE.UP && ethTrend === TREND_TYPE.UP;
  const isDown = btcTrend === TREND_TYPE.DOWN && ethTrend === TREND_TYPE.DOWN;
  return isUp || isDown;
}

function recoverTriggeredAmbushesWithoutPosition(tradingLoop) {
  if (!tradingLoop.ambushList) {
    return 0;
  }

  let recovered = 0;
  for (const [coin, ambush] of tradingLoop.ambushList.entries()) {
    if (ambush?.triggered && !tradingLoop.activePositions?.has(coin)) {
      ambush.triggered = false;
      recovered += 1;
      logger.warn('Ambush trigger reset because no position was opened', {
        coin,
        ready: Boolean(ambush.ready),
        expectedSignal: ambush.expectedSignal || null
      });
    }
  }

  return recovered;
}

export function installAmbushPipelineDiagnostics(tradingLoop) {
  if (!tradingLoop || tradingLoop.__pipelineDiagnosticsInstalled) {
    return;
  }

  tradingLoop.__pipelineDiagnosticsInstalled = true;
  const candleMetadata = new WeakMap();
  let currentStats = null;
  let lastKnownTrend = null;

  const rememberCandles = (candles, coin, interval) => {
    if (Array.isArray(candles)) {
      candleMetadata.set(candles, { coin, interval });
    }
    return candles;
  };

  const wrapCandleSource = (source, methodName) => {
    if (!source || typeof source[methodName] !== 'function') {
      return;
    }

    const original = source[methodName].bind(source);
    source[methodName] = async (coin, interval, ...args) => {
      const candles = await original(coin, interval, ...args);
      return rememberCandles(candles, coin, interval);
    };
  };

  wrapCandleSource(tradingLoop.marketData, 'getKlines');
  wrapCandleSource(tradingLoop.historicalCandleCache, 'getOrFetchCandles');

  if (tradingLoop.trend && typeof tradingLoop.trend.analyzeTrend === 'function') {
    const originalAnalyzeTrend = tradingLoop.trend.analyzeTrend.bind(tradingLoop.trend);
    tradingLoop.trend.analyzeTrend = async (...args) => {
      const result = await originalAnalyzeTrend(...args);
      const resolvedTrend = result?.btcTrend || result?.trend || null;
      const resolvedEthTrend = result?.ethTrend || null;

      if (resolvedTrend) {
        lastKnownTrend = resolvedTrend;
      }

      if (currentStats) {
        currentStats.trend = resolvedTrend;
        currentStats.btcTrend = resolvedTrend;
        currentStats.ethTrend = resolvedEthTrend;
        currentStats.trendEvaluatedThisCycle = true;
        currentStats.trendPassed = evaluateTrendPass(tradingLoop, resolvedTrend, resolvedEthTrend);
      }

      logger.info('Trend timeframe diagnostic', {
        interval: config.BTC_TREND_INTERVAL,
        trend: resolvedTrend,
        btcTrend: result?.btcTrend || resolvedTrend,
        ethTrend: resolvedEthTrend,
        emaDistance: result?.emaDistance ?? null,
        emaSlope: result?.emaSlope ?? null,
        adx: result?.adx ?? null
      });

      return result;
    };
  }

  if (tradingLoop.similarity && typeof tradingLoop.similarity.analyzeSimilarity === 'function') {
    const originalAnalyzeSimilarity = tradingLoop.similarity.analyzeSimilarity.bind(tradingLoop.similarity);
    tradingLoop.similarity.analyzeSimilarity = async (coinCandles, ...args) => {
      const result = await originalAnalyzeSimilarity(coinCandles, ...args);
      const metadata = candleMetadata.get(coinCandles) || {};
      const scorePercent = Number(result?.score || 0) * 100;
      const effectiveThreshold = getEffectiveThreshold(currentStats?.trend || lastKnownTrend);
      const passed = scorePercent >= effectiveThreshold;

      if (currentStats) {
        currentStats.coinsScanned += 1;
        if (passed) {
          currentStats.similarityPassed += 1;
        } else {
          currentStats.similarityRejected += 1;
        }
      }

      logger.info(passed ? 'AMBUSH CANDIDATE PASSED (Similarity)' : 'AMBUSH CANDIDATE REJECTED (Similarity)', {
        coin: metadata.coin || null,
        interval: metadata.interval || config.SIMILARITY_INTERVAL,
        scorePercent,
        effectiveThreshold,
        trend: currentStats?.trend || lastKnownTrend
      });

      return result;
    };
  }

  if (tradingLoop.trigger && typeof tradingLoop.trigger.analyzeTrigger === 'function') {
    const originalAnalyzeTrigger = tradingLoop.trigger.analyzeTrigger.bind(tradingLoop.trigger);
    tradingLoop.trigger.analyzeTrigger = async (candles, ...args) => {
      const result = await originalAnalyzeTrigger(candles, ...args);
      const metadata = candleMetadata.get(candles) || {};

      if (currentStats) {
        currentStats.bollingerChecks += 1;
        if (result?.triggered) {
          currentStats.bollingerPassed += 1;
        }
      }

      if (!result?.triggered) {
        logger.info('AMBUSH CANDIDATE REJECTED (Bollinger/Signal)', {
          coin: metadata.coin || null,
          interval: metadata.interval || config.READY_BOLLINGER_INTERVAL,
          touchType: result?.type || null
        });
      }

      return result;
    };
  }

  if (tradingLoop.riskManager && typeof tradingLoop.riskManager.validatePosition === 'function') {
    const originalValidatePosition = tradingLoop.riskManager.validatePosition.bind(tradingLoop.riskManager);
    tradingLoop.riskManager.validatePosition = async (coin, ...args) => {
      const result = await originalValidatePosition(coin, ...args);
      if (currentStats && !result?.allowed) {
        currentStats.riskRejected += 1;
      }
      if (!result?.allowed) {
        logger.info('AMBUSH CANDIDATE REJECTED (Risk)', {
          coin,
          reason: result?.reason || null
        });
      }
      return result;
    };
  }

  if (typeof tradingLoop.checkOneMinuteConfirmation === 'function') {
    const originalConfirmation = tradingLoop.checkOneMinuteConfirmation.bind(tradingLoop);
    tradingLoop.checkOneMinuteConfirmation = (...args) => {
      const result = originalConfirmation(...args);
      if (currentStats) {
        currentStats.confirmationChecks += 1;
        if (result?.confirmed) {
          currentStats.confirmationPassed += 1;
        }
      }
      return result;
    };
  }

  if (typeof tradingLoop.enterPosition === 'function') {
    const originalEnterPosition = tradingLoop.enterPosition.bind(tradingLoop);
    tradingLoop.enterPosition = async (coin, ...args) => {
      const result = await originalEnterPosition(coin, ...args);
      if (result && currentStats) {
        currentStats.createdPositions += 1;
      }
      if (result) {
        logger.info('AMBUSH CANDIDATE CREATED', { coin });
      }
      return result;
    };
  }

  const originalRunStrategyCycle = tradingLoop.runStrategyCycle.bind(tradingLoop);
  tradingLoop.runStrategyCycle = async (...args) => {
    if (tradingLoop.isStrategyCycleRunning) {
      return originalRunStrategyCycle(...args);
    }

    const cycleStats = createCycleStats();
    currentStats = cycleStats;
    cycleStats.ambushesBefore = tradingLoop.ambushList?.size || 0;
    const refreshTimestampBefore = tradingLoop.lastAmbushRefreshAt;

    try {
      return await originalRunStrategyCycle(...args);
    } finally {
      const cycleScanResult = tradingLoop.lastAmbushScanResult
        && Number(tradingLoop.lastAmbushScanResult.at) >= cycleStats.startedAt
        ? tradingLoop.lastAmbushScanResult
        : null;

      cycleStats.refreshPerformed = tradingLoop.lastAmbushRefreshAt !== refreshTimestampBefore;
      cycleStats.refreshStatus = cycleScanResult?.status || null;
      cycleStats.refreshReason = cycleScanResult?.reason || null;
      cycleStats.nextRefreshInMs = getNextRefreshInMs(tradingLoop);
      cycleStats.recoveredTriggeredAmbushes = recoverTriggeredAmbushesWithoutPosition(tradingLoop);
      cycleStats.ambushesAfter = tradingLoop.ambushList?.size || 0;
      cycleStats.readyAmbushes = tradingLoop.ambushList
        ? [...tradingLoop.ambushList.values()].filter((ambush) => ambush.ready && !ambush.triggered).length
        : 0;

      const ambushStates = tradingLoop.ambushList
        ? [...tradingLoop.ambushList.entries()].slice(0, 20).map(([coin, ambush]) => ({
            coin,
            ready: Boolean(ambush.ready),
            triggered: Boolean(ambush.triggered),
            expectedSignal: ambush.expectedSignal || null,
            readyReason: ambush.readyReason || null
          }))
        : [];

      logger.info('AMBUSH PIPELINE SUMMARY', {
        durationMs: Date.now() - cycleStats.startedAt,
        similarityInterval: config.SIMILARITY_INTERVAL,
        trendInterval: config.BTC_TREND_INTERVAL,
        refreshPerformed: cycleStats.refreshPerformed,
        nextRefreshInMs: cycleStats.nextRefreshInMs,
        trendEvaluatedThisCycle: cycleStats.trendEvaluatedThisCycle,
        trend: cycleStats.btcTrend || cycleStats.trend || lastKnownTrend,
        btcTrend: cycleStats.btcTrend || cycleStats.trend || lastKnownTrend,
        ethTrend: cycleStats.ethTrend,
        trendPassed: cycleStats.trendEvaluatedThisCycle
          ? cycleStats.trendPassed
          : evaluateTrendPass(tradingLoop, lastKnownTrend, cycleStats.ethTrend),
        refreshStatus: cycleStats.refreshStatus,
        refreshReason: cycleStats.refreshReason,
        coinsScanned: cycleStats.coinsScanned,
        similarityPassed: cycleStats.similarityPassed,
        similarityRejected: cycleStats.similarityRejected,
        bollingerChecks: cycleStats.bollingerChecks,
        bollingerPassed: cycleStats.bollingerPassed,
        confirmationChecks: cycleStats.confirmationChecks,
        confirmationPassed: cycleStats.confirmationPassed,
        readyAmbushes: cycleStats.readyAmbushes,
        createdPositions: cycleStats.createdPositions,
        riskRejected: cycleStats.riskRejected,
        recoveredTriggeredAmbushes: cycleStats.recoveredTriggeredAmbushes,
        ambushesBefore: cycleStats.ambushesBefore,
        ambushesAfter: cycleStats.ambushesAfter,
        ambushStates
      });

      if (currentStats === cycleStats) {
        currentStats = null;
      }
    }
  };

  logger.info('Ambush pipeline diagnostics installed', {
    similarityInterval: config.SIMILARITY_INTERVAL,
    trendInterval: config.BTC_TREND_INTERVAL
  });
}

export default installAmbushPipelineDiagnostics;
