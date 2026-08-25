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
  error: jest.fn(),
  debug: jest.fn()
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
const diagnosticsModule = await import('../../src/diagnostics/ambush-pipeline-diagnostics.js');
const configModule = await import('../../src/config/config.js');
const { TREND_TYPE } = await import('../../src/shared/types/index.js');

const installAmbushPipelineDiagnostics = diagnosticsModule.default;
const config = configModule.default;

function createCandles(count, start = 100) {
  return Array.from({ length: count }, (_, i) => ({
    open: start + i,
    high: start + i + 1,
    low: start + i - 1,
    close: start + i + 0.5,
    volume: 1000 + i,
    openTime: i * 60_000,
    closeTime: (i + 1) * 60_000
  }));
}

function buildLoop(trendResult) {
  const trendRequiredCandles = Math.max(
    Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
    Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
  ) + 1;

  const loop = new TradingLoop(
    {
      candleService: {},
      marketData: {
        getTop100Coins: jest.fn(async () => []),
        getKlines: jest.fn(async () => createCandles(config.SIMILARITY_WINDOW_SIZE))
      },
      historicalCandleCache: {
        getOrFetchCandles: jest.fn(async (symbol, interval, limit) => {
          if (interval === process.env.BTC_TREND_INTERVAL) {
            return createCandles(Math.max(limit, trendRequiredCandles), symbol === 'ETHUSDT' ? 200 : 100);
          }
          if (interval === process.env.SIMILARITY_INTERVAL) {
            return createCandles(config.SIMILARITY_WINDOW_SIZE, symbol === 'ETHUSDT' ? 300 : 250);
          }
          return createCandles(limit || 20, 400);
        })
      },
      orderService: {
        isLiveTradingEnabled: jest.fn(() => false),
        clearPositionRiskCycleCache: jest.fn(),
        clearOpenOrdersCycleCache: jest.fn(),
        placeOrder: jest.fn()
      }
    },
    {
      similarity: {
        analyzeSimilarity: jest.fn(async () => ({
          score: 0.9,
          btcSimilarity: 0.9,
          ethSimilarity: 0.9,
          finalSimilarity: 0.9,
          scores: {}
        }))
      },
      trend: {
        analyzeTrend: jest.fn(async () => trendResult)
      },
      trigger: { period: 20, analyzeTrigger: jest.fn(async () => ({ triggered: false, type: null })) },
      riskManager: { validateTrade: jest.fn(async () => ({ approved: true })) }
    }
  );

  installAmbushPipelineDiagnostics(loop);
  return loop;
}

function findLatestSummary() {
  const summaryCalls = loggerMock.info.mock.calls.filter((call) => call[0] === 'AMBUSH PIPELINE SUMMARY');
  return summaryCalls.length > 0 ? summaryCalls[summaryCalls.length - 1][1] : null;
}

describe('Ambush pipeline diagnostics', () => {
  const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
  const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;
  const originalTopCoinsCount = process.env.TOP_COINS_COUNT;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BTC_TREND_INTERVAL = '1h';
    process.env.SIMILARITY_INTERVAL = '15m';
    process.env.TOP_COINS_COUNT = '600';
  });

  afterAll(() => {
    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
    process.env.TOP_COINS_COUNT = originalTopCoinsCount;
  });

  test('G) trendPassed false for SIDEWAYS and mismatch, true for UP/UP and DOWN/DOWN; nextRefreshInMs finite', async () => {
    const cases = [
      {
        name: 'SIDEWAYS',
        trendResult: { trend: TREND_TYPE.SIDEWAYS, btcTrend: TREND_TYPE.SIDEWAYS, ethTrend: TREND_TYPE.DOWN },
        expectedPassed: false
      },
      {
        name: 'MISMATCH',
        trendResult: { trend: TREND_TYPE.UP, btcTrend: TREND_TYPE.UP, ethTrend: TREND_TYPE.DOWN },
        expectedPassed: false
      },
      {
        name: 'UP_UP',
        trendResult: { trend: TREND_TYPE.UP, btcTrend: TREND_TYPE.UP, ethTrend: TREND_TYPE.UP },
        expectedPassed: true
      },
      {
        name: 'DOWN_DOWN',
        trendResult: { trend: TREND_TYPE.DOWN, btcTrend: TREND_TYPE.DOWN, ethTrend: TREND_TYPE.DOWN },
        expectedPassed: true
      }
    ];

    for (const testCase of cases) {
      const loop = buildLoop(testCase.trendResult);
      await loop.runStrategyCycle();
      const summary = findLatestSummary();

      expect(summary).toBeTruthy();
      expect(summary.trendPassed).toBe(testCase.expectedPassed);
      expect(typeof summary.nextRefreshInMs).toBe('number');
      expect(Number.isFinite(summary.nextRefreshInMs)).toBe(true);
      expect(summary.nextRefreshInMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('overlapping strategy calls keep the active cycle diagnostics isolated', async () => {
    const loop = buildLoop({
      trend: TREND_TYPE.UP,
      btcTrend: TREND_TYPE.UP,
      ethTrend: TREND_TYPE.UP
    });
    let releaseTopCoins;
    const topCoinsStarted = new Promise((resolve) => {
      loop.marketData.getTop100Coins.mockImplementationOnce(() => {
        resolve();
        return new Promise((release) => {
          releaseTopCoins = release;
        });
      });
    });

    const activeCycle = loop.runStrategyCycle();
    await topCoinsStarted;

    await expect(loop.runStrategyCycle()).resolves.toBeUndefined();

    releaseTopCoins([]);
    await expect(activeCycle).resolves.toBeUndefined();

    const summaryCalls = loggerMock.info.mock.calls.filter(
      (call) => call[0] === 'AMBUSH PIPELINE SUMMARY'
    );
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0][1].durationMs).toBeGreaterThanOrEqual(0);
  });
});
