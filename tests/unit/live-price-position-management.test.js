import { jest } from '@jest/globals';

const notificationMock = {
  sendMessage: jest.fn(),
  sendTradeSummary: jest.fn(),
  sendAmbushSummary: jest.fn(),
  sendError: jest.fn(),
  sendOrUpdatePerformanceReport: jest.fn(),
  sendBreakEven: jest.fn(),
  sendProtectionActivated: jest.fn(),
  sendStopUpdate: jest.fn(),
  sendTrailingActivated: jest.fn(),
  sendTakeProfitUpdate: jest.fn()
};

const tradeSnapshotMock = {
  recordEntry: jest.fn(),
  recordExit: jest.fn(),
  recordProtection: jest.fn()
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
const configModule = await import('../../src/config/config.js');

const config = configModule.default;

function createFlatCandles(count, close = 100, range = 1) {
  return Array.from({ length: count }, (_, i) => ({
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: 1000 + i,
    openTime: i * 60_000,
    closeTime: (i + 1) * 60_000
  }));
}

function createOrderService({
  live = true,
  currentPrice = 100,
  currentPriceErrorSymbols = new Set(),
  livePositionBySymbol = new Map()
} = {}) {
  const getCurrentPrice = jest.fn(async (symbol) => {
    if (currentPriceErrorSymbols.has(symbol)) {
      throw new Error(`PRICE_FETCH_FAILED_${symbol}`);
    }
    return typeof currentPrice === 'function' ? currentPrice(symbol) : currentPrice;
  });

  const getOpenPosition = jest.fn(async (symbol) => {
    if (!live) {
      return null;
    }

    const fromMap = livePositionBySymbol.get(symbol);
    if (fromMap) {
      return fromMap;
    }

    return {
      symbol,
      quantity: 1,
      side: 'BUY',
      entryPrice: 100,
      markPrice: Number(typeof currentPrice === 'function' ? currentPrice(symbol) : currentPrice),
      leverage: 2,
      notional: 100,
      unrealizedProfit: 0
    };
  });

  return {
    isLiveTradingEnabled: jest.fn(() => live),
    primePositionRiskCycleCache: jest.fn(async () => new Map()),
    primeOpenOrdersCycleCache: jest.fn(async () => []),
    clearPositionRiskCycleCache: jest.fn(),
    clearOpenOrdersCycleCache: jest.fn(),
    getCurrentPrice,
    getOpenPosition,
    getOpenOrders: jest.fn(async () => []),
    createStopLossOrder: jest.fn(async ({ stopPrice }) => ({ orderId: `SL_${stopPrice}`, order: { id: `SL_${stopPrice}`, stopPrice } })),
    createTakeProfitOrder: jest.fn(async ({ stopPrice }) => ({ orderId: `TP_${stopPrice}`, order: { id: `TP_${stopPrice}`, stopPrice } })),
    replaceStopLoss: jest.fn(async ({ stopPrice }) => ({ orderId: `RSL_${stopPrice}`, order: { stopPrice } })),
    replaceTakeProfit: jest.fn(async ({ stopPrice }) => ({ orderId: `RTP_${stopPrice}`, order: { stopPrice } })),
    cancelOrder: jest.fn(async () => ({ success: true })),
    simulateProtectiveOrderFill: jest.fn(async () => null),
    placeOrder: jest.fn()
  };
}

function createLoop({
  live = true,
  currentPrice = 100,
  currentPriceErrorSymbols = new Set(),
  candleClose = 100,
  livePositionBySymbol = new Map()
} = {}) {
  const orderService = createOrderService({
    live,
    currentPrice,
    currentPriceErrorSymbols,
    livePositionBySymbol
  });

  const loop = new TradingLoop(
    {
      candleService: {},
      marketData: {
        getKlines: jest.fn(async () => createFlatCandles(20, candleClose, 1)),
        getTop100Coins: jest.fn(async () => [{ symbol: 'AAAUSDT' }])
      },
      historicalCandleCache: {
        getOrFetchCandles: jest.fn(async () => createFlatCandles(20, candleClose, 1))
      },
      orderService
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
        analyzeTrend: jest.fn(async () => ({
          trend: 'UP',
          confidence: 0.9,
          btcTrend: 'UP',
          ethTrend: 'UP'
        }))
      },
      trigger: {
        period: 20,
        analyzeTrigger: jest.fn(async () => ({ triggered: false, type: null }))
      },
      riskManager: { validateTrade: jest.fn(async () => ({ approved: true })) }
    }
  );

  jest.spyOn(loop, 'ensureProtectionOrders').mockResolvedValue();
  return { loop, orderService };
}

function createPosition(loop, {
  coin,
  signal,
  entryPrice = 100,
  stopPrice,
  takeProfitPrice,
  breakEvenActivated = false,
  beTriggerPercent = 99,
  trailingAtrMultiplier = 1
}) {
  const position = loop.createPositionState({
    ownership: 'BOT_CONFIRMED',
    coin,
    signal,
    leverage: 2,
    tradeSizeUsdt: 100,
    quantity: 1,
    entryPrice,
    stopPrice,
    takeProfitPrice,
    tpPercent: 1,
    slPercent: 1,
    breakEvenActivated,
    beTriggerPercent,
    trailingAtrMultiplier,
    trailingActivated: false
  });
  position.stopOrderId = `${coin}_SL`;
  position.takeProfitOrderId = `${coin}_TP`;
  return position;
}

describe('Live Price Position Management', () => {
  const originalAtrPeriod = config.ATR_PERIOD;
  const originalBeAtrMultiplier = config.BE_ATR_MULTIPLIER;
  const originalTpStepAtrMultiplier = config.TP_STEP_ATR_MULTIPLIER;
  const originalMinTpStepPercent = config.MIN_TP_STEP_PERCENT;
  const originalPositionFollowMode = config.POSITION_FOLLOW_MODE;
  const originalAppMode = config.APP_MODE;
  const originalEnableRealTrading = config.ENABLE_REAL_TRADING;
  const originalDelayedProtectionEnabled = config.DELAYED_PROTECTION_ENABLED;
  const originalExcludedEntrySymbols = config.EXCLUDED_ENTRY_SYMBOLS;

  beforeEach(() => {
    jest.clearAllMocks();
    config.ATR_PERIOD = 2;
    config.BE_ATR_MULTIPLIER = 1.0;
    config.TP_STEP_ATR_MULTIPLIER = 0.5;
    config.MIN_TP_STEP_PERCENT = 0.5;
    config.POSITION_FOLLOW_MODE = 'LEGACY';
    config.APP_MODE = 'paper';
    config.ENABLE_REAL_TRADING = false;
    config.DELAYED_PROTECTION_ENABLED = true;
    config.EXCLUDED_ENTRY_SYMBOLS = new Set(['XAUTUSDT', 'PAXGUSDT', 'BTCDOMUSDT']);
  });

  afterAll(() => {
    config.ATR_PERIOD = originalAtrPeriod;
    config.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
    config.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
    config.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    config.POSITION_FOLLOW_MODE = originalPositionFollowMode;
    config.APP_MODE = originalAppMode;
    config.ENABLE_REAL_TRADING = originalEnableRealTrading;
    config.DELAYED_PROTECTION_ENABLED = originalDelayedProtectionEnabled;
    config.EXCLUDED_ENTRY_SYMBOLS = originalExcludedEntrySymbols;
  });

  test.each(['XAUTUSDT', 'PAXGUSDT', 'BTCDOMUSDT'])(
    'rejects excluded entry symbol %s before trend validation or order placement',
    async (symbol) => {
      const { loop, orderService } = createLoop({ live: false });
      const trendGuard = jest.spyOn(loop, 'validateEntryTrend');

      await expect(loop.enterPosition(symbol, 100, 'BUY')).resolves.toBeNull();

      expect(loop.isEntrySymbolExcluded(symbol)).toBe(true);
      expect(loop.isEntrySymbolExcluded('AAAUSDT')).toBe(false);
      expect(trendGuard).not.toHaveBeenCalled();
      expect(orderService.placeOrder).not.toHaveBeenCalled();
    }
  );

  test('updates BUY trailing stop with fresh price even when closed 1m candle close is unchanged', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 105, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'AAAUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('AAAUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.getCurrentPrice).toHaveBeenCalledWith('AAAUSDT');
    expect(orderService.replaceStopLoss).toHaveBeenCalledTimes(1);
  });

  test('updates SELL trailing stop with fresh price even when closed 1m candle close is unchanged', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 95, candleClose: 100 });
    const sell = createPosition(loop, {
      coin: 'BBBUSDT',
      signal: 'SELL',
      stopPrice: 100,
      takeProfitPrice: 99,
      breakEvenActivated: true
    });

    loop.activePositions.set('BBBUSDT', sell);
    await loop.monitorOpenPositions();

    expect(orderService.getCurrentPrice).toHaveBeenCalledWith('BBBUSDT');
    expect(orderService.replaceStopLoss).toHaveBeenCalledTimes(1);
  });

  test('uses fresh price for break-even trigger evaluation', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 102, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'CCCUSDT',
      signal: 'BUY',
      stopPrice: 99,
      takeProfitPrice: 101,
      breakEvenActivated: false,
      beTriggerPercent: 99
    });

    loop.activePositions.set('CCCUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.replaceStopLoss).toHaveBeenCalled();
    expect(buy.breakEvenActivated).toBe(true);
  });

  test('uses fresh price for dynamic take-profit evaluation', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 103, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'DDDUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('DDDUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.replaceTakeProfit).toHaveBeenCalledTimes(1);
    expect(buy.takeProfitPrice).toBeGreaterThan(103);
  });

  test('does not worsen stop or TP on adverse fresh price move', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 99, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'EEEUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('EEEUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(orderService.replaceTakeProfit).not.toHaveBeenCalled();
    expect(buy.stopPrice).toBe(100);
    expect(buy.takeProfitPrice).toBe(101);
  });

  test('does not send redundant protection updates when same fresh price repeats', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 103, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'FFFUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('FFFUSDT', buy);
    await loop.monitorOpenPositions();
    const stopCallsAfterFirst = orderService.replaceStopLoss.mock.calls.length;
    const tpCallsAfterFirst = orderService.replaceTakeProfit.mock.calls.length;

    await loop.monitorOpenPositions();

    expect(orderService.replaceStopLoss.mock.calls.length).toBe(stopCallsAfterFirst);
    expect(orderService.replaceTakeProfit.mock.calls.length).toBe(tpCallsAfterFirst);
  });

  test('skips protection updates for invalid fresh prices', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: Number.NaN, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'GGGUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('GGGUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(orderService.replaceTakeProfit).not.toHaveBeenCalled();
  });

  test('does not fall back to stale candle price when fresh price request fails', async () => {
    const { loop, orderService } = createLoop({
      live: true,
      candleClose: 103,
      currentPriceErrorSymbols: new Set(['HHHUSDT'])
    });
    const buy = createPosition(loop, {
      coin: 'HHHUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('HHHUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.getCurrentPrice).toHaveBeenCalledWith('HHHUSDT');
    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(orderService.replaceTakeProfit).not.toHaveBeenCalled();
  });

  test('price failure on one symbol does not block monitoring of other symbols', async () => {
    const { loop, orderService } = createLoop({
      live: true,
      candleClose: 100,
      currentPrice: 95,
      currentPriceErrorSymbols: new Set(['IIIUSDT'])
    });

    const failBuy = createPosition(loop, {
      coin: 'IIIUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });
    const okSell = createPosition(loop, {
      coin: 'JJJUSDT',
      signal: 'SELL',
      stopPrice: 100,
      takeProfitPrice: 99,
      breakEvenActivated: true
    });

    loop.activePositions.set('IIIUSDT', failBuy);
    loop.activePositions.set('JJJUSDT', okSell);

    await loop.monitorOpenPositions();

    expect(orderService.getCurrentPrice).toHaveBeenCalledWith('IIIUSDT');
    expect(orderService.getCurrentPrice).toHaveBeenCalledWith('JJJUSDT');
    expect(orderService.replaceStopLoss).toHaveBeenCalledTimes(1);
  });

  test('does not request fresh prices when there are no open positions', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 101, candleClose: 100 });

    await loop.monitorOpenPositions();

    expect(orderService.getCurrentPrice).not.toHaveBeenCalled();
  });

  test('runStrategyCycle keeps using candle-based analysis and does not request fresh position prices', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 101, candleClose: 100 });
    loop.lastAmbushRefreshAt = Date.now();

    await loop.runStrategyCycle();

    expect(orderService.getCurrentPrice).not.toHaveBeenCalled();
  });

  test('paper mode does not send real market orders while monitoring positions', async () => {
    const { loop, orderService } = createLoop({ live: false, currentPrice: 105, candleClose: 100 });
    const buy = createPosition(loop, {
      coin: 'KKKUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('KKKUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.placeOrder).not.toHaveBeenCalled();
  });

  test('live mode still executes cycle cache priming/cleanup guards', async () => {
    const { loop, orderService } = createLoop({
      live: true,
      candleClose: 100,
      currentPriceErrorSymbols: new Set(['LLLUSDT'])
    });
    const buy = createPosition(loop, {
      coin: 'LLLUSDT',
      signal: 'BUY',
      stopPrice: 100,
      takeProfitPrice: 101,
      breakEvenActivated: true
    });

    loop.activePositions.set('LLLUSDT', buy);
    await loop.monitorOpenPositions();

    expect(orderService.primePositionRiskCycleCache).toHaveBeenCalledTimes(1);
    expect(orderService.primeOpenOrdersCycleCache).toHaveBeenCalledTimes(1);
    expect(orderService.clearPositionRiskCycleCache).toHaveBeenCalledTimes(1);
    expect(orderService.clearOpenOrdersCycleCache).toHaveBeenCalledTimes(1);
  });

  test('delayed staged mode keeps the emergency stop unchanged until its one-time activation timestamp', async () => {
    const { loop, orderService } = createLoop({ live: false, currentPrice: 100, candleClose: 100 });
    config.POSITION_FOLLOW_MODE = 'STAGED_R_ATR';
    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED', coin: 'WAITUSDT', signal: 'BUY', entryPrice: 100,
      quantity: 1, tradeSizeUsdt: 100, stopPrice: 95, takeProfitPrice: null,
      delayedProtectionEnabled: true, followStage: 'PROTECTION_DELAY',
      protectionActivationAt: Date.now() + 60000
    });

    const result = await loop.syncPositionLifecycle(position, { close: 100 }, createFlatCandles(20), 100);

    expect(result).toEqual({ closed: false });
    expect(position.stopPrice).toBe(95);
    expect(orderService.createStopLossOrder).not.toHaveBeenCalled();
    expect(orderService.createTakeProfitOrder).not.toHaveBeenCalled();
  });

  test('enables the paper-tested delayed staged strategy for fully enabled live trading', () => {
    const { loop } = createLoop({ live: true });
    config.POSITION_FOLLOW_MODE = 'STAGED_R_ATR';
    config.APP_MODE = 'live';
    config.ENABLE_REAL_TRADING = true;

    expect(loop.isDelayedProtectionMode()).toBe(true);

    config.ENABLE_REAL_TRADING = false;
    expect(loop.isDelayedProtectionMode()).toBe(false);
  });

  test('opens a paper position with the 1.5% hard initial stop cap and assigns one random activation timestamp', async () => {
    const { loop, orderService } = createLoop({ live: false });
    loop.ensureProtectionOrders.mockRestore();
    config.POSITION_FOLLOW_MODE = 'STAGED_R_ATR';
    jest.spyOn(loop, 'validateEntryTrend').mockResolvedValue({
      allowed: true,
      btcTrend: 'UP',
      ethTrend: 'UP'
    });
    jest.spyOn(loop, 'evaluateFinalDirectionalEntryGate').mockResolvedValue({
      allowed: true,
      mode: 'NORMAL',
      btc15Supertrend: 'UP'
    });
    orderService.placeOrder.mockResolvedValue({
      success: true,
      orderId: 'ENTRY_1',
      order: { avgPrice: 100, quantity: 1 }
    });
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    const result = await loop.enterPosition('ENTRYWAITUSDT', 100, 'BUY', [], null, {
      verdict: 'WOULD_CONFIRM',
      breadth15m: { state: 'UP' }
    });

    randomSpy.mockRestore();
    expect(result.position).toEqual(expect.objectContaining({
      followStage: 'PROTECTION_DELAY',
      delayedProtectionEnabled: true,
      stopPrice: 98.5,
      takeProfitPrice: null
    }));
    expect(result.position.protectionActivationAt - result.position.enteredAt).toBe(150000);
    expect(orderService.createStopLossOrder).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 98.5 }));
    expect(orderService.createTakeProfitOrder).not.toHaveBeenCalled();
    expect(tradeSnapshotMock.recordEntry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: loop.sessionId,
      sessionStartedAt: loop.sessionStartedAt,
      targetRiskUsdt: config.RISK_PER_TRADE_USDT,
      plannedStructuralStopPrice: expect.any(Number),
      structuralStopPercent: expect.any(Number),
      plannedNotionalUsdt: expect.any(Number),
      executedNotionalUsdt: 100,
      requestedQuantity: expect.any(Number),
      executedQuantity: 1,
      positionFollowMode: 'STAGED_R_ATR'
    }));
    expect(loggerMock.info).toHaveBeenCalledWith('Position Entry', expect.objectContaining({
      sessionId: loop.sessionId,
      executedNotionalUsdt: 100,
      executedQuantity: 1
    }));
  });

  test('creates a distinct session id per bot process and persists exit telemetry', () => {
    const { loop } = createLoop({ live: false });
    const { loop: secondLoop } = createLoop({ live: false });
    expect(loop.sessionId).toEqual(expect.any(String));
    expect(secondLoop.sessionId).not.toBe(loop.sessionId);

    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED',
      coin: 'TELEMETRYUSDT',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1,
      tradeSizeUsdt: 100,
      stopPrice: 99,
      takeProfitPrice: 103,
      entryOrderId: 'ENTRY_TELEMETRY',
      entryCommission: 0.04,
      sessionId: loop.sessionId,
      sessionStartedAt: loop.sessionStartedAt,
      targetRiskUsdt: 2,
      plannedRiskUsdt: 1,
      executedRiskUsdt: 1,
      plannedStructuralStopPrice: 99,
      structuralStopPercent: 1,
      configuredMaxNotionalUsdt: 100,
      plannedNotionalUsdt: 100,
      executedNotionalUsdt: 100,
      requestedQuantity: 1,
      executedQuantity: 1,
      highestPriceSinceEntry: 102,
      lowestPriceSinceEntry: 99.5,
      followStage: 'TRAILING'
    });

    loop.buildClosedPositionResult(position, 101, 'TRAILING_TP', 'EXIT_TELEMETRY');

    expect(tradeSnapshotMock.recordExit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: loop.sessionId,
      targetRiskUsdt: 2,
      plannedRiskUsdt: 1,
      executedRiskUsdt: 1,
      structuralStopPercent: 1,
      executedNotionalUsdt: 100,
      executedQuantity: 1,
      finalFollowStage: 'TRAILING',
      maxFavorableExcursionPercent: 2,
      maxAdverseExcursionPercent: -0.5
    }));
    expect(loggerMock.info).toHaveBeenCalledWith('Position Exit', expect.objectContaining({
      sessionId: loop.sessionId,
      maxFavorableExcursionPercent: 2,
      maxAdverseExcursionPercent: -0.5
    }));
  });

  test('opens a fully enabled live position with the same delayed protection state as paper', async () => {
    const { loop, orderService } = createLoop({ live: true });
    loop.ensureProtectionOrders.mockRestore();
    config.POSITION_FOLLOW_MODE = 'STAGED_R_ATR';
    config.APP_MODE = 'live';
    config.ENABLE_REAL_TRADING = true;
    jest.spyOn(loop, 'validateEntryTrend').mockResolvedValue({
      allowed: true,
      btcTrend: 'UP',
      ethTrend: 'UP'
    });
    jest.spyOn(loop, 'evaluateFinalDirectionalEntryGate').mockResolvedValue({
      allowed: true,
      mode: 'NORMAL',
      btc15Supertrend: 'UP'
    });
    orderService.placeOrder.mockResolvedValue({
      success: true,
      orderId: 'LIVE_ENTRY_1',
      order: { avgPrice: 100, quantity: 1 }
    });
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    const result = await loop.enterPosition('LIVESTAGEDUSDT', 100, 'BUY', [], null, {
      verdict: 'WOULD_CONFIRM',
      breadth15m: { state: 'UP' }
    });

    randomSpy.mockRestore();
    expect(orderService.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'LIVESTAGEDUSDT',
      side: 'BUY',
      type: 'MARKET',
      reduceOnly: false
    }));
    expect(result.position).toEqual(expect.objectContaining({
      followStage: 'PROTECTION_DELAY',
      delayedProtectionEnabled: true,
      stopPrice: 98.5,
      takeProfitPrice: null
    }));
    expect(result.position.protectionActivationAt - result.position.enteredAt).toBe(150000);
    expect(orderService.createStopLossOrder).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 98.5 }));
    expect(orderService.createTakeProfitOrder).not.toHaveBeenCalled();
  });

  test('resolves the configured random protection delay once within 1-4 minutes', () => {
    const { loop } = createLoop({ live: false });
    expect(loop.resolveProtectionDelayMs(0)).toBe(60000);
    expect(loop.resolveProtectionDelayMs(0.5)).toBe(150000);
    expect(loop.resolveProtectionDelayMs(1)).toBe(240000);
  });

  test('does not charge entry commission when the market order fails', async () => {
    const { loop, orderService } = createLoop({ live: false });
    jest.spyOn(loop, 'validateEntryTrend').mockResolvedValue({ allowed: true, btcTrend: 'UP', ethTrend: 'UP' });
    jest.spyOn(loop, 'evaluateFinalDirectionalEntryGate').mockResolvedValue({
      allowed: true,
      mode: 'NORMAL',
      btc15Supertrend: 'UP'
    });
    orderService.placeOrder.mockResolvedValue({ success: false });
    const startingCommission = loop.totalCommissionUsdt;
    const startingWallet = loop.paperWalletBalanceUsdt;

    await expect(loop.enterPosition('FAILEDUSDT', 100, 'BUY', [], null, {
      verdict: 'WOULD_CONFIRM',
      breadth15m: { state: 'UP' }
    })).resolves.toBeNull();
    expect(loop.totalCommissionUsdt).toBe(startingCommission);
    expect(loop.paperWalletBalanceUsdt).toBe(startingWallet);
  });

  test('keeps breadth symmetric as risk sizing while hard direction is decided elsewhere', () => {
    const { loop } = createLoop({ live: false });
    const previousVetoEnabled = config.MARKET_BREADTH_ENTRY_VETO_ENABLED;
    const previousNeutralRisk = config.MARKET_BREADTH_NEUTRAL_RISK_USDT;
    const previousOpposedRisk = config.MARKET_BREADTH_OPPOSED_RISK_USDT;
    const previousRisk = config.RISK_PER_TRADE_USDT;
    config.MARKET_BREADTH_ENTRY_VETO_ENABLED = true;
    config.MARKET_BREADTH_NEUTRAL_RISK_USDT = 0.5;
    config.MARKET_BREADTH_OPPOSED_RISK_USDT = 0.25;
    config.RISK_PER_TRADE_USDT = 2;

    expect(loop.evaluateSelectiveRegimePolicy('BUY', null, {
      verdict: 'WOULD_VETO',
      reason: '15M_BREADTH_OPPOSES_ENTRY',
      breadth15m: { state: 'DOWN' }
    })).toMatchObject({ allowed: true, reason: 'BREADTH_OPPOSED_MIN_RISK', targetRiskUsdt: 0.25 });
    expect(loop.evaluateSelectiveRegimePolicy('SELL', null, {
      verdict: 'WOULD_VETO',
      reason: '15M_BREADTH_OPPOSES_ENTRY',
      breadth15m: { state: 'UP' }
    })).toMatchObject({ allowed: true, reason: 'BREADTH_OPPOSED_MIN_RISK', targetRiskUsdt: 0.25 });
    expect(loop.evaluateSelectiveRegimePolicy('SELL', null, {
      verdict: 'WOULD_CONFIRM',
      breadth15m: { state: 'NEUTRAL' }
    })).toMatchObject({
      allowed: true,
      reason: 'BREADTH_NEUTRAL_REDUCED_RISK',
      targetRiskUsdt: 0.5
    });
    expect(loop.calculateRiskSizedTradeSizeFromStop(100, 98, 100, 0.5)).toBeCloseTo(25);

    config.MARKET_BREADTH_ENTRY_VETO_ENABLED = previousVetoEnabled;
    config.MARKET_BREADTH_NEUTRAL_RISK_USDT = previousNeutralRisk;
    config.MARKET_BREADTH_OPPOSED_RISK_USDT = previousOpposedRisk;
    config.RISK_PER_TRADE_USDT = previousRisk;
  });

  test('reduces notional when the structural stop is wider while keeping monetary risk capped', () => {
    const { loop } = createLoop({ live: false });
    const previousRisk = config.RISK_PER_TRADE_USDT;
    const previousMinimum = config.MIN_RISK_SIZED_TRADE_USDT;
    config.RISK_PER_TRADE_USDT = 1;
    config.MIN_RISK_SIZED_TRADE_USDT = 1;
    const candles = createFlatCandles(20, 100, 2);
    const sized = loop.calculateRiskSizedTradeSize(100, 'BUY', candles, 100);
    config.RISK_PER_TRADE_USDT = previousRisk;
    config.MIN_RISK_SIZED_TRADE_USDT = previousMinimum;
    expect(sized).toBeLessThan(100);
    expect(sized).toBeGreaterThan(0);
  });

  test('caps structural stops at the 1.5% hard initial loss limit for LONG and SHORT', () => {
    const { loop } = createLoop({ live: false });
    const candles = createFlatCandles(20, 100, 1);
    candles[3].low = 90;
    candles[7].high = 110;
    const long = createPosition(loop, { coin: 'LONGSTRUCTUSDT', signal: 'BUY', stopPrice: 80, takeProfitPrice: 120 });
    const short = createPosition(loop, { coin: 'SHORTSTRUCTUSDT', signal: 'SELL', stopPrice: 120, takeProfitPrice: 80 });
    long.tickSize = 0.01;
    short.tickSize = 0.01;

    expect(loop.calculateStructuralStopPrice(long, candles)).toBeCloseTo(98.5, 10);
    expect(loop.calculateStructuralStopPrice(short, candles)).toBeCloseTo(101.5, 10);
  });

  test('creates only the capped structural SL at activation and arms the legacy staged target', async () => {
    const { loop, orderService } = createLoop({ live: false, candleClose: 100 });
    config.POSITION_FOLLOW_MODE = 'STAGED_R_ATR';
    loop.ensureProtectionOrders.mockRestore();
    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED', coin: 'ACTIVATEUSDT', signal: 'BUY', entryPrice: 100,
      quantity: 1, tradeSizeUsdt: 100, stopPrice: null, takeProfitPrice: null,
      delayedProtectionEnabled: true, followStage: 'PROTECTION_DELAY', protectionActivationAt: Date.now()
    });
    position.tickSize = 0.01;
    position.pricePrecision = 2;

    const result = await loop.activateDelayedProtection(position, 100);

    expect(result).toEqual(expect.objectContaining({ closed: false, protected: true }));
    expect(position.stopPrice).toBeCloseTo(98.5, 10);
    expect(position.profitLockPrice).toBeCloseTo(100.5, 10);
    expect(position.followStage).toBe('PROFIT_TARGET');
    expect(orderService.createStopLossOrder).toHaveBeenCalledTimes(1);
    expect(orderService.createTakeProfitOrder).not.toHaveBeenCalled();
    expect(notificationMock.sendProtectionActivated).toHaveBeenCalledWith('ACTIVATEUSDT', {
      signal: 'BUY',
      entryPrice: 100,
      delayMs: expect.any(Number),
      stopPrice: 98.5,
      profitLockPrice: 100.5,
      interval: '15m',
      lookback: 20
    });
    expect(position.protectionActivationNotificationSent).toBe(true);
  });

  test('closes at market when activation-time price is already beyond the structural stop', async () => {
    const { loop, orderService } = createLoop({ live: false, candleClose: 100 });
    const position = loop.createPositionState({
      ownership: 'BOT_CONFIRMED', coin: 'BREACHUSDT', signal: 'BUY', entryPrice: 100,
      quantity: 1, tradeSizeUsdt: 100, stopPrice: null, takeProfitPrice: null,
      delayedProtectionEnabled: true, followStage: 'PROTECTION_DELAY', protectionActivationAt: Date.now()
    });
    position.tickSize = 0.01;
    position.pricePrecision = 2;
    orderService.placeOrder.mockResolvedValue({ success: true, orderId: 'CLOSE_1', order: { avgPrice: 98 } });

    const result = await loop.activateDelayedProtection(position, 98);

    expect(result.closed).toBe(true);
    expect(orderService.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BREACHUSDT', side: 'SELL', type: 'MARKET', reduceOnly: true
    }));
    expect(notificationMock.sendProtectionActivated).not.toHaveBeenCalled();
  });

  test('applies the +1.0%/+0.35% profit floor first and avoids multiple stop rewrites in the same cooldown cycle', async () => {
    const { loop, orderService } = createLoop({ live: true });
    config.POSITION_FOLLOW_MODE = 'STAGED_R_ATR';
    const position = createPosition(loop, {
      coin: 'LOCKUSDT', signal: 'BUY', stopPrice: 99, takeProfitPrice: 100.5
    });
    position.delayedProtectionEnabled = true;
    position.followStage = 'PROFIT_TARGET';
    position.profitLockPrice = 100.5;
    position.highestPriceSinceEntry = 101;
    position.btcTrend = 'UP';
    position.ethTrend = 'UP';

    await loop.applyStagedPositionFollow(position, 101, [], 0.1);

    expect(orderService.replaceStopLoss).toHaveBeenCalledTimes(1);
    expect(orderService.replaceStopLoss.mock.calls[0][0].stopPrice).toBeCloseTo(100.35, 10);
    expect(position.stopPrice).toBeCloseTo(100.35, 10);
    expect(position.followStage).toBe('PROFIT_TARGET');
    expect(notificationMock.sendStopUpdate).toHaveBeenLastCalledWith(
      'LOCKUSDT',
      100.35,
      expect.objectContaining({ reason: 'PERCENT_PROFIT_FLOOR_1PCT_TO_0_35' })
    );
  });

  test('tightens delayed ATR trailing at 1.5R and logs the chandelier stage', async () => {
    const { loop, orderService } = createLoop({ live: true });
    const position = createPosition(loop, {
      coin: 'TIGHTENUSDT', signal: 'BUY', stopPrice: 100.6, takeProfitPrice: 103
    });
    position.delayedProtectionEnabled = true;
    position.followStage = 'WIDE_TRAILING';
    position.profitLockPrice = 100.5;
    position.initialStopPrice = 99;
    position.initialRisk = 1;
    position.highestPriceSinceEntry = 102;
    position.lowestPriceSinceEntry = 100;
    position.btcTrend = 'UP';
    position.ethTrend = 'UP';

    await loop.applyStagedPositionFollow(position, 102, [], 0.5);

    expect(orderService.replaceStopLoss).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 100.875 }));
    expect(position.followStage).toBe('TRAILING');
    expect(notificationMock.sendStopUpdate).toHaveBeenLastCalledWith(
      'TIGHTENUSDT',
      100.875,
      expect.objectContaining({ reason: 'STAGED_R_ATR_CHANDELIER' })
    );
  });

  test('mirrors the delayed 1.5R chandelier tightening for SHORT positions', async () => {
    const { loop, orderService } = createLoop({ live: true });
    const position = createPosition(loop, {
      coin: 'SHORTTIGHTENUSDT', signal: 'SELL', stopPrice: 99.4, takeProfitPrice: 97
    });
    position.delayedProtectionEnabled = true;
    position.followStage = 'WIDE_TRAILING';
    position.profitLockPrice = 99.5;
    position.initialStopPrice = 101;
    position.initialRisk = 1;
    position.highestPriceSinceEntry = 100;
    position.lowestPriceSinceEntry = 98;
    position.btcTrend = 'DOWN';
    position.ethTrend = 'DOWN';

    await loop.applyStagedPositionFollow(position, 98, [], 0.5);

    expect(orderService.replaceStopLoss).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 99.125 }));
    expect(position.followStage).toBe('TRAILING');
    expect(notificationMock.sendStopUpdate).toHaveBeenLastCalledWith(
      'SHORTTIGHTENUSDT',
      99.125,
      expect.objectContaining({ reason: 'STAGED_R_ATR_CHANDELIER' })
    );
  });

  test('staged mode trails from the true high and widens for aligned BTC/ETH trend', async () => {
    const { loop, orderService } = createLoop({ live: true, currentPrice: 101.4, candleClose: 100 });
    const position = createPosition(loop, {
      coin: 'CHANDELIERUSDT', signal: 'BUY', stopPrice: 100.1, takeProfitPrice: 103, breakEvenActivated: true
    });
    position.initialStopPrice = 99;
    position.initialRisk = 1;
    position.highestPriceSinceEntry = 102;
    position.lowestPriceSinceEntry = 100;
    position.btcTrend = 'UP';
    position.ethTrend = 'UP';

    await loop.applyStagedPositionFollow(position, 101.4, [], 0.5);

    expect(orderService.replaceStopLoss).toHaveBeenCalledWith(expect.objectContaining({ stopPrice: 100.875 }));
    expect(position.followStage).toBe('TRAILING');
  });

  test('staged trailing uses the weak multiplier when BTC and ETH diverge', () => {
    const { loop } = createLoop({ live: true });
    expect(loop.resolveRegimeTrailingMultiplier({ signal: 'BUY', btcTrend: 'UP', ethTrend: 'DOWN' })).toBe(1.25);
  });

  test('notifies break-even once even when current stop is already safer', async () => {
    const { loop, orderService } = createLoop({ live: true });
    const position = createPosition(loop, {
      coin: 'BEALREADYUSDT', signal: 'BUY', stopPrice: 101, takeProfitPrice: 103
    });

    await loop.activateBreakEven(position);
    await loop.activateBreakEven(position);

    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(notificationMock.sendBreakEven).toHaveBeenCalledTimes(1);
    expect(notificationMock.sendBreakEven).toHaveBeenCalledWith(
      'BEALREADYUSDT',
      101,
      expect.objectContaining({ stopAdjusted: false })
    );
  });

  test('notifies ATR trailing activation even when stop cannot improve', async () => {
    const { loop, orderService } = createLoop({ live: true });
    const position = createPosition(loop, {
      coin: 'TRAILREADYUSDT', signal: 'BUY', stopPrice: 200, takeProfitPrice: 210, breakEvenActivated: true
    });

    await loop.updateTrailingStop(position, 105, createFlatCandles(20), 1);
    await loop.updateTrailingStop(position, 105, createFlatCandles(20), 1);

    expect(orderService.replaceStopLoss).not.toHaveBeenCalled();
    expect(notificationMock.sendTrailingActivated).toHaveBeenCalledTimes(1);
  });

  test('final directional gate allows normal LONG when BTC15 SuperTrend is UP', async () => {
    const { loop } = createLoop({ live: false });
    jest.spyOn(loop, 'calculateFinalGateSupertrend').mockReturnValue({ direction: 'UP', value: 99, close: 100 });

    const result = await loop.evaluateFinalDirectionalEntryGate('AAAUSDT', 'BUY', {
      breadth15m: { upCount: 10, downCount: 90 }
    });

    expect(result).toEqual(expect.objectContaining({ allowed: true, mode: 'STRICT_FINAL', reason: 'BTC15_ST_STRICT_CONFIRMED', btc15Supertrend: 'UP' }));
  });

  test('final directional gate allows normal SHORT when BTC15 SuperTrend is DOWN', async () => {
    const { loop } = createLoop({ live: false });
    jest.spyOn(loop, 'calculateFinalGateSupertrend').mockReturnValue({ direction: 'DOWN', value: 101, close: 100 });

    const result = await loop.evaluateFinalDirectionalEntryGate('AAAUSDT', 'SELL', {
      breadth15m: { upCount: 90, downCount: 10 }
    });

    expect(result).toEqual(expect.objectContaining({ allowed: true, mode: 'STRICT_FINAL', reason: 'BTC15_ST_STRICT_CONFIRMED', btc15Supertrend: 'DOWN' }));
  });

  test('final directional gate never rescues LONG against a red BTC15 SuperTrend', async () => {
    const { loop } = createLoop({ live: false, candleClose: 100 });
    jest.spyOn(loop, 'calculateFinalGateSupertrend').mockReturnValue({ direction: 'DOWN', value: 101, close: 100 });
    loop.trigger.calculateBollingerBands = jest.fn(() => ({ middle: 101 }));

    const result = await loop.evaluateFinalDirectionalEntryGate('AAAUSDT', 'BUY', {
      breadth15m: { upCount: 90, downCount: 30 }
    });

    expect(result).toEqual(expect.objectContaining({
      allowed: false,
      mode: 'BLOCK',
      reason: 'BTC15_ST_STRICT_MISMATCH',
      btc15Supertrend: 'DOWN',
      requiredDirection: 'UP'
    }));
  });

  test('final directional gate never rescues SHORT against a green BTC15 SuperTrend', async () => {
    const { loop } = createLoop({ live: false, candleClose: 100 });
    jest.spyOn(loop, 'calculateFinalGateSupertrend').mockReturnValue({ direction: 'UP', value: 99, close: 100 });
    loop.trigger.calculateBollingerBands = jest.fn(() => ({ middle: 99 }));

    const result = await loop.evaluateFinalDirectionalEntryGate('AAAUSDT', 'SELL', {
      breadth15m: { upCount: 30, downCount: 90 }
    });

    expect(result).toEqual(expect.objectContaining({
      allowed: false,
      mode: 'BLOCK',
      reason: 'BTC15_ST_STRICT_MISMATCH',
      btc15Supertrend: 'UP',
      requiredDirection: 'DOWN'
    }));
  });

  test('final directional gate blocks every countertrend entry without rescue logic', async () => {
    const { loop } = createLoop({ live: false, candleClose: 100 });
    jest.spyOn(loop, 'calculateFinalGateSupertrend').mockReturnValue({ direction: 'DOWN', value: 101, close: 100 });
    loop.trigger.calculateBollingerBands = jest.fn(() => ({ middle: 101 }));

    const result = await loop.evaluateFinalDirectionalEntryGate('AAAUSDT', 'BUY', {
      breadth15m: { upCount: 89, downCount: 30 }
    });

    expect(result).toEqual(expect.objectContaining({
      allowed: false,
      mode: 'BLOCK',
      reason: 'BTC15_ST_STRICT_MISMATCH'
    }));
  });

  test('notifies dynamic take-profit after successful replacement', async () => {
    const { loop } = createLoop({ live: true });
    const position = createPosition(loop, {
      coin: 'TPUPDATEUSDT', signal: 'BUY', stopPrice: 100, takeProfitPrice: 101, breakEvenActivated: true
    });

    await loop.updateDynamicTakeProfit(position, 103, createFlatCandles(20), 1);

    expect(notificationMock.sendTakeProfitUpdate).toHaveBeenCalledWith(
      'TPUPDATEUSDT',
      expect.any(Number),
      expect.objectContaining({ reason: 'ATR_DYNAMIC_TP' })
    );
  });
});

