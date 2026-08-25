import { jest } from '@jest/globals';

const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: loggerMock
}));

jest.unstable_mockModule('../../src/services/notification-service.js', () => ({
  default: {
    sendMessage: jest.fn(),
    sendTradeSummary: jest.fn(),
    sendAmbushSummary: jest.fn(),
    sendError: jest.fn(),
    sendOrUpdatePerformanceReport: jest.fn()
  }
}));

jest.unstable_mockModule('../../src/statistics/trade-snapshot-service.js', () => ({
  default: {
    recordEntry: jest.fn(),
    recordExit: jest.fn()
  }
}));

const { TradingLoop } = await import('../../src/trading-loop.js');
const { TREND_TYPE } = await import('../../src/shared/types/index.js');
const configModule = await import('../../src/config/config.js');

const config = configModule.default;

function createCandles(count, start = 100) {
  return Array.from({ length: count }, (_, index) => ({
    open: start + index,
    high: start + index + 2,
    low: start + index - 2,
    close: start + index + 1,
    volume: 1000 + index
  }));
}

function buildLoop(trendResult, marketDataOverride = {}) {
  const requiredCandles = Math.max(
    Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
    Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
  ) + 1;
  const marketData = {
    getKlines: jest.fn(async (symbol) => createCandles(requiredCandles, symbol === 'BTCUSDT' ? 100 : 200)),
    ...marketDataOverride
  };
  const orderService = {
    placeOrder: jest.fn(),
    isLiveTradingEnabled: jest.fn(() => false),
    clearPositionRiskCycleCache: jest.fn(),
    clearOpenOrdersCycleCache: jest.fn()
  };
  const loop = new TradingLoop(
    {
      candleService: {},
      marketData,
      historicalCandleCache: null,
      orderService
    },
    {
      similarity: {},
      trend: {
        analyzeTrend: jest.fn(async () => trendResult)
      },
      trigger: { period: 20 },
      riskManager: {}
    }
  );

  return { loop, marketData, orderService, requiredCandles };
}

describe('Final BTC/ETH entry trend guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows BTC UP with ETH sideways after weight renormalization', async () => {
    const { loop } = buildLoop({
      trend: TREND_TYPE.UP,
      btcTrend: TREND_TYPE.UP,
      ethTrend: TREND_TYPE.SIDEWAYS
    });

    await expect(loop.validateEntryTrend('BUY')).resolves.toMatchObject({
      allowed: true,
      direction: 'BUY',
      reason: 'WEIGHTED_MARKET_TREND_CONFIRMED'
    });
  });

  test('rejects an insufficient weighted score', async () => {
    const { loop } = buildLoop({
      trend: TREND_TYPE.SIDEWAYS,
      btcTrend: TREND_TYPE.SIDEWAYS,
      ethTrend: TREND_TYPE.UP
    });

    await expect(loop.validateEntryTrend('BUY')).resolves.toMatchObject({
      allowed: false,
      reason: 'WEIGHTED_MARKET_TREND_SIDEWAYS'
    });
  });

  test('blocks a strong BTC/ETH direction conflict', async () => {
    const { loop } = buildLoop({
      trend: TREND_TYPE.UP,
      btcTrend: TREND_TYPE.UP,
      ethTrend: TREND_TYPE.DOWN
    });

    await expect(loop.validateEntryTrend('BUY')).resolves.toMatchObject({
      allowed: false,
      reason: 'BTC_ETH_STRONG_CONFLICT'
    });
  });

  test('rejects when current aligned direction differs from the ambush signal', async () => {
    const { loop } = buildLoop({
      trend: TREND_TYPE.DOWN,
      btcTrend: TREND_TYPE.DOWN,
      ethTrend: TREND_TYPE.DOWN
    });

    await expect(loop.validateEntryTrend('BUY')).resolves.toMatchObject({
      allowed: false,
      reason: 'ENTRY_SIGNAL_TREND_MISMATCH'
    });
  });

  test('fails closed when current BTC or ETH data cannot be fetched', async () => {
    const { loop } = buildLoop(
      { trend: TREND_TYPE.UP, btcTrend: TREND_TYPE.UP, ethTrend: TREND_TYPE.UP },
      { getKlines: jest.fn(async () => { throw new Error('market unavailable'); }) }
    );

    await expect(loop.validateEntryTrend('BUY')).resolves.toMatchObject({
      allowed: false,
      reason: 'ENTRY_TREND_VALIDATION_FAILED'
    });
  });

  test('uses fresh market data for both assets and allows only the matching direction', async () => {
    const { loop, marketData, requiredCandles } = buildLoop({
      trend: TREND_TYPE.UP,
      btcTrend: TREND_TYPE.UP,
      ethTrend: TREND_TYPE.UP
    });

    await expect(loop.validateEntryTrend('BUY')).resolves.toMatchObject({
      allowed: true,
      direction: 'BUY'
    });
    expect(marketData.getKlines).toHaveBeenCalledWith('BTCUSDT', expect.any(String), expect.any(Number));
    expect(marketData.getKlines).toHaveBeenCalledWith('ETHUSDT', expect.any(String), expect.any(Number));
    expect(loop.trend.analyzeTrend.mock.calls[0][0]).toHaveLength(requiredCandles);
    expect(loop.trend.analyzeTrend.mock.calls[0][1]).toHaveLength(requiredCandles);
  });

  test('blocks enterPosition before commission mutation and order placement', async () => {
    const { loop, orderService } = buildLoop({
      trend: TREND_TYPE.SIDEWAYS,
      btcTrend: TREND_TYPE.SIDEWAYS,
      ethTrend: TREND_TYPE.SIDEWAYS
    });
    const startingWallet = loop.paperWalletBalanceUsdt;
    const startingCommission = loop.totalCommissionUsdt;

    await expect(loop.enterPosition('AAAUSDT', 100, 'BUY', [], 90)).resolves.toBeNull();

    expect(orderService.placeOrder).not.toHaveBeenCalled();
    expect(loop.paperWalletBalanceUsdt).toBe(startingWallet);
    expect(loop.totalCommissionUsdt).toBe(startingCommission);
  });
});
