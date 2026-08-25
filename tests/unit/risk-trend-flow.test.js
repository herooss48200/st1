import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';

const notificationMock = {
  sendMessage: jest.fn(),
  sendTradeSummary: jest.fn(),
  sendAmbushSummary: jest.fn(),
  sendError: jest.fn(),
  sendOrUpdatePerformanceReport: jest.fn()
};

const tradeSnapshotMock = {
  recordEntry: jest.fn(),
  recordExit: jest.fn()
};

const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../src/services/notification-service.js', () => ({
  default: notificationMock
}));

jest.unstable_mockModule('../../src/statistics/trade-snapshot-service.js', () => ({
  default: tradeSnapshotMock
}));

jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: loggerMock
}));

const { TradingLoop } = await import('../../src/trading-loop.js');
const { TREND_TYPE } = await import('../../src/shared/types/index.js');
const { RiskManager } = await import('../../src/engines/risk-manager.js');
const { SimilarityEngine } = await import('../../src/engines/similarity-engine.js');
const configModule = await import('../../src/config/config.js');

const config = configModule.default;

function createCandles(count, start = 100) {
  return Array.from({ length: count }, (_, i) => ({
    open: start + i,
    high: start + i + 2,
    low: start + i - 2,
    close: start + i + 1,
    volume: 1000 + i,
    openTime: i * 60_000,
    closeTime: (i + 1) * 60_000
  }));
}

function syncAtrRuntimeConfigFromEnv() {
  const atrPeriod = Number.parseInt(process.env.ATR_PERIOD || '', 10);
  if (Number.isFinite(atrPeriod)) {
    config.ATR_PERIOD = atrPeriod;
  }

  const beAtrMultiplier = Number.parseFloat(process.env.BE_ATR_MULTIPLIER || '');
  if (Number.isFinite(beAtrMultiplier)) {
    config.BE_ATR_MULTIPLIER = beAtrMultiplier;
  }

  const tpStepAtrMultiplier = Number.parseFloat(process.env.TP_STEP_ATR_MULTIPLIER || '');
  if (Number.isFinite(tpStepAtrMultiplier)) {
    config.TP_STEP_ATR_MULTIPLIER = tpStepAtrMultiplier;
  }

  const minTpStepPercent = Number.parseFloat(process.env.MIN_TP_STEP_PERCENT || '');
  if (Number.isFinite(minTpStepPercent)) {
    config.MIN_TP_STEP_PERCENT = minTpStepPercent;
  }
}

describe('Risk and Trend Flow Fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // These assertions intentionally cover the backwards-compatible legacy engine.
    config.POSITION_FOLLOW_MODE = 'LEGACY';
  });

  test('does not use Math.random and accepts valid position deterministically', async () => {
    const riskManagerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/engines/risk-manager.js'),
      'utf8'
    );

    expect(riskManagerSource.includes('Math.random')).toBe(false);

    const manager = new RiskManager();
    const context = {
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 102,
      currentPositions: [],
      tradingHistory: []
    };

    const first = await manager.validatePosition('BTCUSDT', context);
    const second = await manager.validatePosition('BTCUSDT', context);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(first.reason).toBe('All checks passed');
    expect(second.reason).toBe('All checks passed');
  });

  test('produces explicit reason/checks when finite position limits are exceeded', async () => {
    const previousUnlimited = process.env.PAPER_UNLIMITED_POSITIONS;
    process.env.PAPER_UNLIMITED_POSITIONS = 'false';
    try {
      const manager = new RiskManager();
      const fullPositions = Array.from({ length: manager.maxPositionsTotal }, (_, i) => ({
        coin: `COIN_${i}`
      }));

      const result = await manager.validateTrade(
        {
          id: 'LIMIT_TEST',
          coin: 'BTCUSDT',
          entryPrice: 100,
          stopLoss: 99,
          takeProfit: 101
        },
        fullPositions,
        [],
        { minRiskRewardRatio: 1 }
      );

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Failed: positionCount');
      expect(result.checks.positionCount.passed).toBe(false);
      expect(result.checks.positionCount.current).toBe(manager.maxPositionsTotal);
    } finally {
      process.env.PAPER_UNLIMITED_POSITIONS = previousUnlimited;
    }
  });

  test('paper mode has no aggregate slot cap but keeps one-position-per-coin protection', () => {
    const previousUnlimited = process.env.PAPER_UNLIMITED_POSITIONS;
    const previousMode = process.env.APP_MODE;
    process.env.APP_MODE = 'paper';
    process.env.PAPER_UNLIMITED_POSITIONS = 'true';
    try {
      const manager = new RiskManager();
      const manyPositions = Array.from({ length: 50 }, (_, i) => ({ coin: `COIN_${i}` }));
      const count = manager.checkPositionCount(manyPositions);
      expect(count.passed).toBe(true);
      expect(count.unlimited).toBe(true);
      expect(count.max).toBeNull();

      const concentration = manager.checkCoinConcentration('COIN_1', manyPositions);
      expect(concentration.passed).toBe(false);
      expect(concentration.max).toBe(1);
    } finally {
      process.env.PAPER_UNLIMITED_POSITIONS = previousUnlimited;
      process.env.APP_MODE = previousMode;
    }
  });

  test.each([
    ['trades', { maxTrades: 1, maxCommission: 25, maxTurnover: 10000, history: [{ totalTradeCommission: 0, turnoverUsdt: 0 }], options: {} }],
    ['commission', { maxTrades: 20000, maxCommission: 0.05, maxTurnover: 10000, history: [], options: { projectedCommissionUsdt: 0.08 } }],
    ['turnover', { maxTrades: 20000, maxCommission: 25, maxTurnover: 100, history: [], options: { projectedTurnoverUsdt: 200 } }]
  ])('reports the exact dailyActivity.%s limit', async (expectedLimit, scenario) => {
    const previous = {
      maxTrades: config.MAX_DAILY_TRADES,
      maxCommission: config.MAX_DAILY_COMMISSION_USDT,
      maxTurnover: config.MAX_DAILY_TURNOVER_USDT
    };
    config.MAX_DAILY_TRADES = scenario.maxTrades;
    config.MAX_DAILY_COMMISSION_USDT = scenario.maxCommission;
    config.MAX_DAILY_TURNOVER_USDT = scenario.maxTurnover;
    const now = Date.now();
    const history = scenario.history.map((trade) => ({ ...trade, closedAt: now }));

    try {
      const manager = new RiskManager();
      const result = await manager.validateTrade(
        { id: 'DAILY_ACTIVITY', coin: 'BTCUSDT', entryPrice: 100, stopLoss: 99, takeProfit: 102 },
        [],
        history,
        { minRiskRewardRatio: 1, ...scenario.options }
      );

      expect(result.approved).toBe(false);
      expect(result.reason).toBe(`Failed: dailyActivity.${expectedLimit}`);
      expect(result.checks.dailyActivity.failedLimits).toEqual([expectedLimit]);
      expect(result.checks.dailyActivity.subchecks[expectedLimit].passed).toBe(false);
    } finally {
      config.MAX_DAILY_TRADES = previous.maxTrades;
      config.MAX_DAILY_COMMISSION_USDT = previous.maxCommission;
      config.MAX_DAILY_TURNOVER_USDT = previous.maxTurnover;
    }
  });

  test('uses 1h trend interval while keeping similarity interval unchanged and sends enough candles for EMA-200', async () => {
    const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
    const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;

    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;

    const historicalCache = {
      getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
        if (symbol === 'BTCUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles));
        if (symbol === 'ETHUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles), 200);
        if (symbol === 'BTCUSDT' && interval === '15m') return createCandles(config.SIMILARITY_WINDOW_SIZE);
        if (symbol === 'ETHUSDT' && interval === '15m') return createCandles(config.SIMILARITY_WINDOW_SIZE, 300);
        if (interval === '15m') return createCandles(config.SIMILARITY_WINDOW_SIZE, 400);
        return createCandles(limit || 250, 500);
      })
    };

    const trendEngine = {
      analyzeTrend: jest.fn(async () => ({
        trend: TREND_TYPE.UP,
        confidence: 0.9,
        btcTrend: TREND_TYPE.UP,
        ethTrend: TREND_TYPE.UP
      }))
    };

    const similarityEngine = {
      analyzeSimilarity: jest.fn(async () => ({
        score: 0.9,
        btcSimilarity: 0.9,
        ethSimilarity: 0.9,
        finalSimilarity: 0.9,
        scores: {}
      }))
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }]),
          getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
        },
        historicalCandleCache: historicalCache,
        orderService: {
          isLiveTradingEnabled: jest.fn(() => false),
          clearPositionRiskCycleCache: jest.fn(),
          clearOpenOrdersCycleCache: jest.fn()
        }
      },
      {
        similarity: similarityEngine,
        trend: trendEngine,
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    await loop.runStrategyCycle();

    expect(historicalCache.getOrFetchCandles).toHaveBeenCalledWith('BTCUSDT', '1h', expect.any(Number));
    expect(historicalCache.getOrFetchCandles).toHaveBeenCalledWith('ETHUSDT', '1h', expect.any(Number));

    expect(historicalCache.getOrFetchCandles).toHaveBeenCalledWith(
      'BTCUSDT',
      '15m',
      config.SIMILARITY_WINDOW_SIZE
    );
    expect(historicalCache.getOrFetchCandles).toHaveBeenCalledWith(
      'AAAUSDT',
      '15m',
      config.SIMILARITY_WINDOW_SIZE
    );

    expect(trendEngine.analyzeTrend).toHaveBeenCalled();
    expect(trendEngine.analyzeTrend.mock.calls[0][0].length).toBeGreaterThanOrEqual(trendRequiredCandles);

    expect(similarityEngine.analyzeSimilarity).toHaveBeenCalled();
    expect(similarityEngine.analyzeSimilarity.mock.calls[0].length).toBe(3);

    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
  });

  test('passes ETH as third argument to analyzeSimilarity for combined scoring', async () => {
    const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
    const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;

    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;

    const historicalCache = {
      getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
        if (symbol === 'BTCUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles));
        if (symbol === 'ETHUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles), 200);
        if (interval === '15m') return createCandles(config.SIMILARITY_WINDOW_SIZE, 400);
        return createCandles(limit || 250, 500);
      })
    };

    const similarityEngine = {
      analyzeSimilarity: jest.fn(async () => ({ score: 0.9, scores: {} }))
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }]),
          getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
        },
        historicalCandleCache: historicalCache,
        orderService: {
          isLiveTradingEnabled: jest.fn(() => false),
          clearPositionRiskCycleCache: jest.fn(),
          clearOpenOrdersCycleCache: jest.fn()
        }
      },
      {
        similarity: similarityEngine,
        trend: {
          analyzeTrend: jest.fn(async () => ({
            trend: TREND_TYPE.UP,
            confidence: 0.9,
            btcTrend: TREND_TYPE.UP,
            ethTrend: TREND_TYPE.UP
          }))
        },
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    await loop.runStrategyCycle();

    expect(similarityEngine.analyzeSimilarity).toHaveBeenCalled();
    for (const call of similarityEngine.analyzeSimilarity.mock.calls) {
      expect(call.length).toBe(3);
    }

    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
  });

  test('uses the single configured RR threshold and subtracts estimated costs', async () => {
    const manager = new RiskManager();

    const defaultResult = await manager.validateTrade(
      {
        id: 'RR_DEFAULT',
        coin: 'BTCUSDT',
        entryPrice: 100,
        stopLoss: 99,
        takeProfit: 101
      },
      [],
      []
    );

    const withCostsResult = await manager.validateTrade(
      {
        id: 'RR_PRETRADE',
        coin: 'BTCUSDT',
        entryPrice: 100,
        stopLoss: 99,
        takeProfit: 101
      },
      [],
      [],
      { estimatedCostsPerUnit: 0.01 }
    );

    expect(defaultResult.approved).toBe(true);
    expect(defaultResult.checks.riskReward.ratio).toBe('1.00');
    expect(defaultResult.checks.riskReward.minRequired).toBe(config.PRE_TRADE_MIN_RISK_REWARD_RATIO);
    expect(withCostsResult.approved).toBe(false);
    expect(withCostsResult.checks.riskReward.ratioRaw).toBeCloseTo(0.99, 8);
  });

  test('keeps full risk history beyond last 20 closed trades', () => {
    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {},
        historicalCandleCache: {},
        orderService: {
          isLiveTradingEnabled: jest.fn(() => false),
          clearPositionRiskCycleCache: jest.fn(),
          clearOpenOrdersCycleCache: jest.fn()
        }
      },
      {
        similarity: {},
        trend: {},
        trigger: { period: 20 },
        riskManager: {}
      }
    );

    const anchor = new Date();
    anchor.setHours(12, 0, 0, 0);
    const now = anchor.getTime();
    for (let i = 0; i < 25; i += 1) {
      loop.recordClosedTrade({
        coin: 'BTCUSDT',
        netPnlForTradeSizeUsdt: -10,
        closedAt: now - i * 1000,
        ref: `T_${i}`
      });
    }

    expect(loop.closedTradeHistory.length).toBe(20);
    expect(loop.riskTradeHistory.length).toBe(25);
    expect(loop.riskTradeHistory.some((trade) => trade.ref === 'T_24')).toBe(true);

    const manager = new RiskManager();
    const dailyLoss = manager.checkDailyLoss(loop.riskTradeHistory);
    expect(dailyLoss.lossPercent).toBe('2.50');
  });

  test('monitor lifecycle continues even when similarity data is missing in strategy cycle', async () => {
    const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
    const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;

    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;

    const historicalCache = {
      getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
        if (symbol === 'BTCUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles));
        if (symbol === 'ETHUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles), 200);
        if (symbol === 'BTCUSDT' && interval === '15m') return createCandles(10);
        if (interval === '1m') return createCandles(20, 600);
        return createCandles(limit || 20, 700);
      })
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }]),
          getKlines: jest.fn(async () => createCandles(20))
        },
        historicalCandleCache: historicalCache,
        orderService: {
          isLiveTradingEnabled: jest.fn(() => false),
          clearPositionRiskCycleCache: jest.fn(),
          clearOpenOrdersCycleCache: jest.fn()
        }
      },
      {
        similarity: { analyzeSimilarity: jest.fn() },
        trend: {
          analyzeTrend: jest.fn(async () => ({
            trend: TREND_TYPE.UP,
            confidence: 0.9,
            btcTrend: TREND_TYPE.UP,
            ethTrend: TREND_TYPE.UP
          }))
        },
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    loop.activePositions.set('AAAUSDT', {
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      entryPrice: 100,
      takeProfitPrice: 110,
      stopPrice: 90,
      breakEvenActivated: false,
      trailingActivated: false
    });

    const syncSpy = jest
      .spyOn(loop, 'syncPositionLifecycle')
      .mockResolvedValue({ closed: false });

    await loop.runStrategyCycle();
    await loop.monitorOpenPositions();

    expect(syncSpy).toHaveBeenCalledTimes(1);

    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
  });

  test('combined similarity maps 100 BTC + 0 ETH to 85 and 0 BTC + 100 ETH to 15', () => {
    const engine = new SimilarityEngine();

    const first = engine.combineSimilarityScores(1, 0) * 100;
    const second = engine.combineSimilarityScores(0, 1) * 100;

    expect(first).toBeCloseTo(85, 10);
    expect(second).toBeCloseTo(15, 10);
  });

  test('trend alignment allows BUY only on BTC UP + ETH UP', () => {
    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService: {} },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const result = loop.evaluateTrendAlignment(TREND_TYPE.UP, TREND_TYPE.UP);
    expect(result.allowed).toBe(true);
    expect(result.direction).toBe('BUY');
  });

  test('trend alignment allows SELL only on BTC DOWN + ETH DOWN', () => {
    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService: {} },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const result = loop.evaluateTrendAlignment(TREND_TYPE.DOWN, TREND_TYPE.DOWN);
    expect(result.allowed).toBe(true);
    expect(result.direction).toBe('SELL');
  });

  test('trend alignment rejects BTC UP + ETH DOWN', () => {
    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService: {} },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const result = loop.evaluateTrendAlignment(TREND_TYPE.UP, TREND_TYPE.DOWN);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('BTC_ETH_STRONG_CONFLICT');
  });

  test('trend alignment rejects BTC DOWN + ETH UP', () => {
    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService: {} },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const result = loop.evaluateTrendAlignment(TREND_TYPE.DOWN, TREND_TYPE.UP);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('BTC_ETH_STRONG_CONFLICT');
  });

  test('trend alignment allows BTC-led direction when ETH is SIDEWAYS', () => {
    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService: {} },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const result = loop.evaluateTrendAlignment(TREND_TYPE.UP, TREND_TYPE.SIDEWAYS);
    expect(result.allowed).toBe(true);
    expect(result.direction).toBe('BUY');
  });

  test('trend alignment rejects when trend data is missing', () => {
    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService: {} },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const result = loop.evaluateTrendAlignment(TREND_TYPE.UP, null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('MARKET_TREND_DATA_UNAVAILABLE');
  });

  test('combined similarity below threshold rejects candidate and does not place order', async () => {
    const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
    const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;
    const originalSimilarityThreshold = process.env.SIMILARITY_THRESHOLD;

    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';
    process.env.SIMILARITY_THRESHOLD = '80';

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;

    const orderService = {
      placeOrder: jest.fn(),
      isLiveTradingEnabled: jest.fn(() => false),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }]),
          getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
        },
        historicalCandleCache: {
          getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
            if (symbol === 'BTCUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles));
            if (symbol === 'ETHUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles), 200);
            if (interval === '15m') return createCandles(config.SIMILARITY_WINDOW_SIZE, 400);
            return createCandles(limit || 250, 500);
          })
        },
        orderService
      },
      {
        similarity: {
          analyzeSimilarity: jest.fn(async () => ({
            score: 0.7,
            btcSimilarity: 0.7,
            ethSimilarity: 0.7,
            finalSimilarity: 0.7,
            scores: {}
          }))
        },
        trend: {
          analyzeTrend: jest.fn(async () => ({
            trend: TREND_TYPE.UP,
            confidence: 0.9,
            btcTrend: TREND_TYPE.UP,
            ethTrend: TREND_TYPE.UP
          }))
        },
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    await loop.runStrategyCycle();

    expect(loop.ambushList.size).toBe(0);
    expect(orderService.placeOrder).not.toHaveBeenCalled();

    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
    process.env.SIMILARITY_THRESHOLD = originalSimilarityThreshold;
  });

  test('retries next cycle and keeps existing candidates when BTC trend candles are unavailable', async () => {
    const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
    const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;
    const originalRefreshMinutes = process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;

    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';
    process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = '30';

    const orderService = {
      placeOrder: jest.fn(),
      isLiveTradingEnabled: jest.fn(() => false),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const historicalCache = {
      getOrFetchCandles: jest.fn(async () => {
        throw new Error('BTC_TEMP_FAILURE');
      })
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }]),
          getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
        },
        historicalCandleCache: historicalCache,
        orderService
      },
      {
        similarity: { analyzeSimilarity: jest.fn() },
        trend: { analyzeTrend: jest.fn() },
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    const preservedCandidate = {
      coin: 'LEGACYUSDT',
      triggered: true,
      ready: false,
      addedAt: 1,
      similarity: 91,
      expectedSignal: 'BUY',
      direction: 'BUY'
    };

    const baselineRefreshAt = 1_000;
    loop.ambushList = new Map([['LEGACYUSDT', preservedCandidate]]);
    loop.lastAmbushRefreshAt = baselineRefreshAt;

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(5_000_000);
    await loop.runStrategyCycle();

    expect(loop.ambushList.has('LEGACYUSDT')).toBe(true);
    expect(loop.lastAmbushRefreshAt).toBe(baselineRefreshAt);
    expect(orderService.placeOrder).not.toHaveBeenCalled();

    const callsAfterFirstCycle = historicalCache.getOrFetchCandles.mock.calls.length;
    nowSpy.mockReturnValueOnce(5_001_000);
    await loop.runStrategyCycle();

    expect(historicalCache.getOrFetchCandles.mock.calls.length).toBeGreaterThan(callsAfterFirstCycle);

    nowSpy.mockRestore();
    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
    process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = originalRefreshMinutes;
  });

  test('retries next cycle and keeps existing candidates when ETH similarity candles are insufficient', async () => {
    const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
    const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;
    const originalRefreshMinutes = process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;

    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';
    process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = '30';

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;

    const orderService = {
      placeOrder: jest.fn(),
      isLiveTradingEnabled: jest.fn(() => false),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const historicalCache = {
      getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
        if (symbol === 'BTCUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles));
        if (symbol === 'ETHUSDT' && interval === '1h') return createCandles(Math.max(limit, trendRequiredCandles), 200);
        if (symbol === 'BTCUSDT' && interval === '15m') return createCandles(config.SIMILARITY_WINDOW_SIZE, 300);
        if (symbol === 'ETHUSDT' && interval === '15m') return createCandles(10, 400);
        return createCandles(limit || 250, 500);
      })
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }]),
          getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
        },
        historicalCandleCache: historicalCache,
        orderService
      },
      {
        similarity: {
          analyzeSimilarity: jest.fn(async () => ({
            score: 0.95,
            btcSimilarity: 0.95,
            ethSimilarity: 0.95,
            finalSimilarity: 0.95,
            scores: {}
          }))
        },
        trend: {
          analyzeTrend: jest.fn(async () => ({
            trend: TREND_TYPE.UP,
            confidence: 0.9,
            btcTrend: TREND_TYPE.UP,
            ethTrend: TREND_TYPE.UP
          }))
        },
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    const preservedCandidate = {
      coin: 'LEGACYUSDT',
      triggered: true,
      ready: false,
      addedAt: 1,
      similarity: 92,
      expectedSignal: 'SELL',
      direction: 'SELL'
    };

    const baselineRefreshAt = 2_000;
    loop.ambushList = new Map([['LEGACYUSDT', preservedCandidate]]);
    loop.lastAmbushRefreshAt = baselineRefreshAt;

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(8_000_000);
    await loop.runStrategyCycle();

    expect(loop.ambushList.has('LEGACYUSDT')).toBe(true);
    expect(loop.lastAmbushRefreshAt).toBe(baselineRefreshAt);
    expect(orderService.placeOrder).not.toHaveBeenCalled();

    const callsAfterFirstCycle = historicalCache.getOrFetchCandles.mock.calls.length;
    nowSpy.mockReturnValueOnce(8_001_000);
    await loop.runStrategyCycle();

    expect(historicalCache.getOrFetchCandles.mock.calls.length).toBeGreaterThan(callsAfterFirstCycle);

    nowSpy.mockRestore();
    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
    process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = originalRefreshMinutes;
  });

  test('BUY position activates break-even after ATR-distance favorable move', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;

    process.env.ATR_PERIOD = '2';
    process.env.BE_ATR_MULTIPLIER = '1.0';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL_BUY_BE', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    position.stopOrderId = 'SL_1';
    position.takeProfitOrderId = 'TP_1';

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 1, low: c.close - 1 }));
    await loop.syncPositionLifecycle(position, { close: 102 }, candles);

    expect(position.breakEvenActivated).toBe(true);
    expect(orderService.replaceStopLoss).toHaveBeenCalledTimes(1);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
    syncAtrRuntimeConfigFromEnv();
  });

  test('SELL position activates break-even after ATR-distance favorable move', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;

    process.env.ATR_PERIOD = '2';
    process.env.BE_ATR_MULTIPLIER = '1.0';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL_SELL_BE', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'SELL',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 101,
      takeProfitPrice: 99,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    position.stopOrderId = 'SL_2';
    position.takeProfitOrderId = 'TP_2';

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 1, low: c.close - 1 }));
    await loop.syncPositionLifecycle(position, { close: 98 }, candles);

    expect(position.breakEvenActivated).toBe(true);
    expect(orderService.replaceStopLoss).toHaveBeenCalledTimes(1);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
    syncAtrRuntimeConfigFromEnv();
  });

  test('BE_ATR_MULTIPLIER changes break-even trigger threshold', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;

    process.env.ATR_PERIOD = '2';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL_BE_DYNAMIC', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 1, low: c.close - 1 }));

    const lowMultiplierPosition = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    lowMultiplierPosition.stopOrderId = 'SL_LOW';
    lowMultiplierPosition.takeProfitOrderId = 'TP_LOW';

    process.env.BE_ATR_MULTIPLIER = '0.5';
    syncAtrRuntimeConfigFromEnv();
    await loop.syncPositionLifecycle(lowMultiplierPosition, { close: 101 }, candles);

    const highMultiplierPosition = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'BBBUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    highMultiplierPosition.stopOrderId = 'SL_HIGH';
    highMultiplierPosition.takeProfitOrderId = 'TP_HIGH';

    process.env.BE_ATR_MULTIPLIER = '2.0';
    syncAtrRuntimeConfigFromEnv();
    await loop.syncPositionLifecycle(highMultiplierPosition, { close: 101 }, candles);

    expect(lowMultiplierPosition.breakEvenActivated).toBe(true);
    expect(highMultiplierPosition.breakEvenActivated).toBe(false);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
    syncAtrRuntimeConfigFromEnv();
  });

  test('TP_STEP_ATR_MULTIPLIER affects dynamic take-profit step', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalTpStepAtrMultiplier = process.env.TP_STEP_ATR_MULTIPLIER;
    const originalMinTpStepPercent = process.env.MIN_TP_STEP_PERCENT;

    process.env.ATR_PERIOD = '2';
    process.env.MIN_TP_STEP_PERCENT = '0.1';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL_TRAIL', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: `TP_${stopPrice}`, order: { stopPrice } })),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 2, low: c.close }));

    const positionLowStep = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 100,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: true,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    positionLowStep.stopOrderId = 'SL3';
    positionLowStep.takeProfitOrderId = 'TP3';

    process.env.TP_STEP_ATR_MULTIPLIER = '0.5';
    syncAtrRuntimeConfigFromEnv();
    await loop.syncPositionLifecycle(positionLowStep, { close: 103 }, candles);
    const tpAfterLowStep = positionLowStep.takeProfitPrice;

    const positionHighStep = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'BBBUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 100,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: true,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    positionHighStep.stopOrderId = 'SL4';
    positionHighStep.takeProfitOrderId = 'TP4';

    process.env.TP_STEP_ATR_MULTIPLIER = '2.0';
    syncAtrRuntimeConfigFromEnv();
    await loop.syncPositionLifecycle(positionHighStep, { close: 103 }, candles);
    const tpAfterHighStep = positionHighStep.takeProfitPrice;

    expect(tpAfterHighStep).toBeGreaterThan(tpAfterLowStep);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
    process.env.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    syncAtrRuntimeConfigFromEnv();
  });

  test('MIN_TP_STEP_PERCENT acts as floor when ATR step is too small', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalTpStepAtrMultiplier = process.env.TP_STEP_ATR_MULTIPLIER;
    const originalMinTpStepPercent = process.env.MIN_TP_STEP_PERCENT;

    process.env.ATR_PERIOD = '2';
    process.env.TP_STEP_ATR_MULTIPLIER = '0.1';
    process.env.MIN_TP_STEP_PERCENT = '1.0';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL5', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: 'TP5', order: { stopPrice } })),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 100,
      takeProfitPrice: 100.9,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: true,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    position.stopOrderId = 'SL6';
    position.takeProfitOrderId = 'TP6';

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 0.05, low: c.close - 0.05 }));
    await loop.syncPositionLifecycle(position, { close: 101 }, candles);

    expect(position.takeProfitPrice).toBeCloseTo(102, 8);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
    process.env.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    syncAtrRuntimeConfigFromEnv();
  });

  test('dynamic TP direction is correct for BUY and SELL', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalTpStepAtrMultiplier = process.env.TP_STEP_ATR_MULTIPLIER;
    const originalMinTpStepPercent = process.env.MIN_TP_STEP_PERCENT;

    process.env.ATR_PERIOD = '2';
    process.env.TP_STEP_ATR_MULTIPLIER = '1.0';
    process.env.MIN_TP_STEP_PERCENT = '0.1';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL7', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: `TP_${stopPrice}`, order: { stopPrice } })),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 1, low: c.close - 1 }));

    const buyPosition = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'BUYUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 100,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: true,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    buyPosition.stopOrderId = 'SL8';
    buyPosition.takeProfitOrderId = 'TP8';

    const sellPosition = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'SELLUSDT',
      signal: 'SELL',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 100,
      takeProfitPrice: 99,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: true,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    sellPosition.stopOrderId = 'SL9';
    sellPosition.takeProfitOrderId = 'TP9';

    await loop.syncPositionLifecycle(buyPosition, { close: 103 }, candles);
    await loop.syncPositionLifecycle(sellPosition, { close: 97 }, candles);

    expect(buyPosition.takeProfitPrice).toBeGreaterThan(103);
    expect(sellPosition.takeProfitPrice).toBeLessThan(97);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
    process.env.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    syncAtrRuntimeConfigFromEnv();
  });

  test('before break-even trigger stop-loss and take-profit are not modified', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;

    process.env.ATR_PERIOD = '2';
    process.env.BE_ATR_MULTIPLIER = '10.0';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL10', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: 'TP10', order: { stopPrice } })),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 0.1,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    position.stopOrderId = 'SL11';
    position.takeProfitOrderId = 'TP11';

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 1, low: c.close - 1 }));
    await loop.syncPositionLifecycle(position, { close: 101 }, candles);

    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(orderService.replaceTakeProfit).not.toHaveBeenCalled();
    expect(position.stopPrice).toBe(99);
    expect(position.takeProfitPrice).toBe(101);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
    syncAtrRuntimeConfigFromEnv();
  });

  test('same price data does not worsen stop or take-profit on repeated processing', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalTpStepAtrMultiplier = process.env.TP_STEP_ATR_MULTIPLIER;
    const originalMinTpStepPercent = process.env.MIN_TP_STEP_PERCENT;

    process.env.ATR_PERIOD = '2';
    process.env.TP_STEP_ATR_MULTIPLIER = '1.0';
    process.env.MIN_TP_STEP_PERCENT = '0.1';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL12', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: 'TP12', order: { stopPrice } })),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 100,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: true,
      beTriggerPercent: 99,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    position.stopOrderId = 'SL13';
    position.takeProfitOrderId = 'TP13';

    const candles = createCandles(3, 100).map((c) => ({ ...c, high: c.close + 1, low: c.close - 1 }));
    await loop.syncPositionLifecycle(position, { close: 103 }, candles);
    const stopAfterFirst = position.stopPrice;
    const tpAfterFirst = position.takeProfitPrice;
    const stopReplaceCallsAfterFirst = orderService.replaceStopLoss.mock.calls.length;
    const tpReplaceCallsAfterFirst = orderService.replaceTakeProfit.mock.calls.length;

    await loop.syncPositionLifecycle(position, { close: 103 }, candles);

    expect(position.stopPrice).toBeGreaterThanOrEqual(stopAfterFirst);
    expect(position.takeProfitPrice).toBeGreaterThanOrEqual(tpAfterFirst);
    expect(orderService.replaceStopLoss.mock.calls.length).toBe(stopReplaceCallsAfterFirst);
    expect(orderService.replaceTakeProfit.mock.calls.length).toBe(tpReplaceCallsAfterFirst);

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
    process.env.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    syncAtrRuntimeConfigFromEnv();
  });

  test('invalid ATR values are rejected safely without sending protection updates or market orders', async () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;

    process.env.ATR_PERIOD = '2';
    process.env.BE_ATR_MULTIPLIER = '1.0';
    syncAtrRuntimeConfigFromEnv();

    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL14', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: 'TP14', order: { stopPrice } })),
      placeOrder: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    };

    const loop = new TradingLoop(
      { candleService: {}, marketData: {}, historicalCandleCache: {}, orderService },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );
    jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 0.1,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    position.stopOrderId = 'SL15';
    position.takeProfitOrderId = 'TP15';

    const invalidCandles = [
      { open: 100, high: Number.NaN, low: 99, close: 100, volume: 1000 },
      { open: 100, high: 101, low: Number.NaN, close: 100, volume: 1000 },
      { open: 100, high: 101, low: 99, close: 100, volume: 1000 }
    ];

    await loop.syncPositionLifecycle(position, { close: 110 }, invalidCandles);

    expect(position.breakEvenActivated).toBe(false);
    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(orderService.replaceTakeProfit).not.toHaveBeenCalled();
    expect(orderService.placeOrder).not.toHaveBeenCalled();

    process.env.ATR_PERIOD = originalAtrPeriod;
    process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
    syncAtrRuntimeConfigFromEnv();
  });

  test('monitorOpenPositions flow is preserved for open positions', async () => {
    const orderService = {
      isLiveTradingEnabled: jest.fn(() => false),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn(),
      simulateProtectiveOrderFill: jest.fn(async () => null),
      replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: 'SL_MON', order: { stopPrice } })),
      replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: 'TP_MON', order: { stopPrice } })),
      placeOrder: jest.fn()
    };

    const loop = new TradingLoop(
      {
        candleService: {},
        marketData: {
          getKlines: jest.fn(async () => createCandles(20, 100))
        },
        historicalCandleCache: {
          getOrFetchCandles: jest.fn(async () => createCandles(20, 100))
        },
        orderService
      },
      { similarity: {}, trend: {}, trigger: { period: 20 }, riskManager: {} }
    );

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'AAAUSDT',
      signal: 'BUY',
      leverage: 2,
      tradeSizeUsdt: 100,
      quantity: 1,
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      tpPercent: 1,
      slPercent: 1,
      breakEvenActivated: false,
      beTriggerPercent: 0.6,
      trailingAtrMultiplier: 1,
      trailingActivated: false
    });
    loop.activePositions.set('AAAUSDT', position);

    const syncSpy = jest.spyOn(loop, 'syncPositionLifecycle').mockResolvedValue({ closed: false });
    await loop.monitorOpenPositions();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(loop.activePositions.has('AAAUSDT')).toBe(true);
  });
});
