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

function createLoop({
  trendResult,
  topCoinsData = [],
  topCoinsError = null,
  similarityByCoin,
  coinCandleBehavior,
  initialAmbushList = new Map()
}) {
  const trendRequiredCandles = Math.max(
    Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
    Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
  ) + 1;

  const topCoinMock = jest.fn(async () => {
    if (topCoinsError) {
      throw topCoinsError;
    }
    return topCoinsData;
  });

  const historicalCache = {
    getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
      if (interval === process.env.BTC_TREND_INTERVAL) {
        return createCandles(Math.max(limit, trendRequiredCandles), symbol === 'ETHUSDT' ? 200 : 100);
      }

      if (interval === process.env.SIMILARITY_INTERVAL) {
        if (symbol === 'BTCUSDT') {
          return createCandles(config.SIMILARITY_WINDOW_SIZE, 300);
        }
        if (symbol === 'ETHUSDT') {
          return createCandles(config.SIMILARITY_WINDOW_SIZE, 400);
        }

        if (typeof coinCandleBehavior === 'function') {
          return coinCandleBehavior(symbol, interval, limit);
        }

        return createCandles(config.SIMILARITY_WINDOW_SIZE, 500);
      }

      return createCandles(limit || 20, 600);
    })
  };

  const similarityEngine = {
    threshold: 0.52,
    analyzeSimilarity: jest.fn(async (coinCandles) => {
      const candle = coinCandles[0] || {};
      const symbolHint = candle.symbolHint || null;
      if (typeof similarityByCoin === 'function') {
        return similarityByCoin(symbolHint);
      }

      return {
        valid: true,
        score: 0.9,
        btcSimilarity: 0.9,
        ethSimilarity: 0.9,
        finalSimilarity: 0.9,
        scores: {}
      };
    })
  };

  const loop = new TradingLoop(
    {
      candleService: {},
      marketData: {
        getTop100Coins: topCoinMock,
        getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
      },
      historicalCandleCache: historicalCache,
      orderService: {
        isLiveTradingEnabled: jest.fn(() => false),
        clearPositionRiskCycleCache: jest.fn(),
        clearOpenOrdersCycleCache: jest.fn(),
        placeOrder: jest.fn()
      }
    },
    {
      similarity: similarityEngine,
      trend: { analyzeTrend: jest.fn(async () => trendResult) },
      trigger: { period: 20, analyzeTrigger: jest.fn(async () => ({ triggered: false, type: null })) },
      riskManager: { validateTrade: jest.fn(async () => ({ approved: true })) }
    }
  );

  loop.ambushList = new Map(initialAmbushList);

  return {
    loop,
    historicalCache,
    similarityEngine,
    topCoinMock
  };
}

describe('Ambush Scan Summary Statuses', () => {
  const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
  const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;
  const originalTopCoinsCount = process.env.TOP_COINS_COUNT;
  const originalRefreshMinutes = process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';
    process.env.TOP_COINS_COUNT = '600';
    process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = '15';
  });

  afterAll(() => {
    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
    process.env.TOP_COINS_COUNT = originalTopCoinsCount;
    process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = originalRefreshMinutes;
  });

  test('A) BTC SIDEWAYS + ETH DOWN => SKIPPED before coin loop', async () => {
    const { loop, topCoinMock, similarityEngine } = createLoop({
      trendResult: {
        trend: TREND_TYPE.SIDEWAYS,
        confidence: 0.9,
        btcTrend: TREND_TYPE.SIDEWAYS,
        ethTrend: TREND_TYPE.DOWN
      }
    });

    await loop.runStrategyCycle();

    expect(topCoinMock).not.toHaveBeenCalled();
    expect(similarityEngine.analyzeSimilarity).not.toHaveBeenCalled();
    expect(notificationMock.sendAmbushSummary).toHaveBeenCalledTimes(1);

    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('SKIPPED');
    expect(payload.reason).toBe('WEIGHTED_MARKET_TREND_SIDEWAYS');
    expect(payload.targetCoins).toBe(600);
    expect(payload.scannedCoins).toBe(0);
  });

  test('B) BTC UP + ETH DOWN => COMPLETED as BTC-led BUY conflict scan', async () => {
    const { loop, similarityEngine, topCoinMock } = createLoop({
      trendResult: {
        trend: TREND_TYPE.UP,
        confidence: 0.9,
        btcTrend: TREND_TYPE.UP,
        ethTrend: TREND_TYPE.DOWN
      },
      topCoinsData: [{ symbol: 'AAAUSDT' }]
    });

    const enterSpy = jest.spyOn(loop, 'enterPosition');

    await loop.runStrategyCycle();

    expect(topCoinMock).toHaveBeenCalledTimes(1);
    expect(similarityEngine.analyzeSimilarity).toHaveBeenCalledTimes(1);
    expect(enterSpy).not.toHaveBeenCalled();

    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('COMPLETED');
    expect(payload.reason).toBe('BTC_ETH_CONFLICT_SCAN_BTC_LED');
    expect(payload.fetchedCoins).toBe(1);
    expect(payload.scannedCoins).toBe(1);
    expect(loop.ambushList.get('AAAUSDT')).toEqual(expect.objectContaining({
      expectedSignal: 'BUY',
      direction: 'BUY',
      scanOnly: true,
      scanReason: 'BTC_ETH_CONFLICT_SCAN_BTC_LED'
    }));
  });

  test('B2) BTC DOWN + ETH UP => COMPLETED as BTC-led SELL conflict scan', async () => {
    const { loop, similarityEngine, topCoinMock } = createLoop({
      trendResult: {
        trend: TREND_TYPE.DOWN,
        confidence: 0.9,
        btcTrend: TREND_TYPE.DOWN,
        ethTrend: TREND_TYPE.UP
      },
      topCoinsData: [{ symbol: 'BBBUSDT' }]
    });

    await loop.runStrategyCycle();

    expect(topCoinMock).toHaveBeenCalledTimes(1);
    expect(similarityEngine.analyzeSimilarity).toHaveBeenCalledTimes(1);
    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('COMPLETED');
    expect(payload.reason).toBe('BTC_ETH_CONFLICT_SCAN_BTC_LED');
    expect(loop.ambushList.get('BBBUSDT')).toEqual(expect.objectContaining({
      expectedSignal: 'SELL',
      direction: 'SELL',
      scanOnly: true
    }));
  });

  test('C) BTC UP + ETH UP => COMPLETED with fetched/scanned split', async () => {
    const topCoins = [{ symbol: 'AAAUSDT' }, { symbol: 'BBBUSDT' }, { symbol: 'CCCUSDT' }];

    const { loop, similarityEngine, topCoinMock } = createLoop({
      trendResult: {
        trend: TREND_TYPE.UP,
        confidence: 0.9,
        btcTrend: TREND_TYPE.UP,
        ethTrend: TREND_TYPE.UP
      },
      topCoinsData: topCoins,
      coinCandleBehavior: (symbol) => {
        if (symbol === 'CCCUSDT') {
          return createCandles(10, 900);
        }
        const candles = createCandles(config.SIMILARITY_WINDOW_SIZE, 700);
        return candles.map((c) => ({ ...c, symbolHint: symbol }));
      },
      similarityByCoin: () => ({
        valid: true,
        score: 0.9,
        btcSimilarity: 0.9,
        ethSimilarity: 0.9,
        finalSimilarity: 0.9,
        scores: {}
      })
    });

    await loop.runStrategyCycle();

    expect(topCoinMock).toHaveBeenCalledTimes(1);
    expect(similarityEngine.analyzeSimilarity).toHaveBeenCalledTimes(2);

    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('COMPLETED');
    expect(payload.fetchedCoins).toBe(3);
    expect(payload.scannedCoins).toBe(2);
  });

  test('D) single coin candle fetch error does not fail whole cycle', async () => {
    const topCoins = [{ symbol: 'AAAUSDT' }, { symbol: 'BBBUSDT' }, { symbol: 'CCCUSDT' }];

    const { loop, similarityEngine } = createLoop({
      trendResult: {
        trend: TREND_TYPE.UP,
        confidence: 0.9,
        btcTrend: TREND_TYPE.UP,
        ethTrend: TREND_TYPE.UP
      },
      topCoinsData: topCoins,
      coinCandleBehavior: (symbol) => {
        if (symbol === 'BBBUSDT') {
          throw new Error('COIN_CANDLE_TEMP_FAILURE');
        }
        return createCandles(config.SIMILARITY_WINDOW_SIZE, 900);
      }
    });

    await loop.runStrategyCycle();

    expect(similarityEngine.analyzeSimilarity).toHaveBeenCalledTimes(2);
    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('COMPLETED');
    expect(payload.scannedCoins).toBe(2);
  });

  test('E) top coin fetch failure => FAILED and no fake completed status', async () => {
    const { loop, similarityEngine } = createLoop({
      trendResult: {
        trend: TREND_TYPE.UP,
        confidence: 0.9,
        btcTrend: TREND_TYPE.UP,
        ethTrend: TREND_TYPE.UP
      },
      topCoinsError: new Error('TOP_COINS_API_DOWN')
    });

    await loop.runStrategyCycle();

    expect(similarityEngine.analyzeSimilarity).not.toHaveBeenCalled();
    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('FAILED');
    expect(payload.reason).toBe('TOP_COINS_FETCH_FAILED');
  });

  test('F) mandatory BTC/ETH data failure preserves ambush list and does not move refresh timestamp', async () => {
    const baselineRefreshAt = 12345;
    const preservedCandidate = {
      coin: 'LEGACYUSDT',
      triggered: false,
      ready: true,
      similarity: 91,
      expectedSignal: 'BUY',
      direction: 'BUY'
    };

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;

    const historicalCache = {
      getOrFetchCandles: jest.fn(async (symbol, interval) => {
        if (symbol === 'BTCUSDT' && interval === process.env.BTC_TREND_INTERVAL) {
          throw new Error('BTC_TEMP_FAILURE');
        }
        return createCandles(trendRequiredCandles, 200);
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
        orderService: {
          isLiveTradingEnabled: jest.fn(() => false),
          clearPositionRiskCycleCache: jest.fn(),
          clearOpenOrdersCycleCache: jest.fn(),
          placeOrder: jest.fn()
        }
      },
      {
        similarity: { analyzeSimilarity: jest.fn() },
        trend: { analyzeTrend: jest.fn() },
        trigger: { period: 20, analyzeTrigger: jest.fn() },
        riskManager: { validateTrade: jest.fn() }
      }
    );

    loop.ambushList = new Map([['LEGACYUSDT', preservedCandidate]]);
    loop.lastAmbushRefreshAt = baselineRefreshAt;

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(2_000_000);
    await loop.runStrategyCycle();

    expect(loop.ambushList.has('LEGACYUSDT')).toBe(true);
    expect(loop.lastAmbushRefreshAt).toBe(baselineRefreshAt);

    const payload = notificationMock.sendAmbushSummary.mock.calls[0][0];
    expect(payload.status).toBe('SKIPPED');
    expect(payload.reason).toBe('BTC_TREND_DATA_UNAVAILABLE');
    expect(payload.ambushCount).toBe(1);

    const callsAfterFirst = historicalCache.getOrFetchCandles.mock.calls.length;
    nowSpy.mockReturnValueOnce(2_001_000);
    await loop.runStrategyCycle();
    expect(historicalCache.getOrFetchCandles.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    nowSpy.mockRestore();
  });
});
