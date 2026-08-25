import { TradingLoop, hasRequiredConfirmations } from '../../src/trading-loop.js';
import { jest } from '@jest/globals';
import config from '../../src/config/config.js';

function buildTradingLoop(overrides = {}) {
  const services = {
    candleService: {},
    marketData: {
      getKlines: jest.fn().mockResolvedValue([])
    },
    historicalCandleCache: {
      getOrFetchCandles: jest.fn().mockResolvedValue([
        { close: 100 },
        { close: 101 }
      ])
    },
    orderService: {
      isLiveTradingEnabled: jest.fn().mockReturnValue(false),
      primePositionRiskCycleCache: jest.fn().mockResolvedValue(undefined),
      primeOpenOrdersCycleCache: jest.fn().mockResolvedValue(undefined),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn(),
      getCurrentPrice: jest.fn().mockResolvedValue(101),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      primePositionRiskCycleCacheFromPositions: jest.fn(),
      getOpenOrders: jest.fn().mockResolvedValue([])
    },
    ...overrides.services
  };

  const engines = {
    similarity: {},
    trend: {},
    trigger: {},
    riskManager: {},
    ...overrides.engines
  };

  return new TradingLoop(services, engines);
}

describe('Sideways confirmation threshold', () => {
  test('confirms when one of three conditions passes', () => {
    expect(hasRequiredConfirmations([true, false, false])).toBe(true);
  });

  test('confirms when two of three conditions pass', () => {
    expect(hasRequiredConfirmations([true, true, false])).toBe(true);
    expect(hasRequiredConfirmations([true, false, true])).toBe(true);
    expect(hasRequiredConfirmations([false, true, true])).toBe(true);
  });

  test('confirms when all three conditions pass', () => {
    expect(hasRequiredConfirmations([true, true, true])).toBe(true);
  });
});

describe('Trending confirmation quality guard', () => {
  const originalRejectVolumeOnly = config.REJECT_VOLUME_ONLY_CONFIRMATION;

  afterEach(() => {
    config.REJECT_VOLUME_ONLY_CONFIRMATION = originalRejectVolumeOnly;
  });

  test('rejects a volume-only confirmation without reversal or band-return context', () => {
    const loop = buildTradingLoop();
    loop.trigger = {
      period: 2,
      calculateBollingerBands: jest.fn(() => ({ lower: 90, upper: 110 })),
      getSourcePrice: jest.fn((candle) => Number(candle.close))
    };
    config.REJECT_VOLUME_ONLY_CONFIRMATION = true;

    const result = loop.checkOneMinuteConfirmation([
      { open: 100, high: 101, low: 99, close: 100, volume: 100 },
      { open: 100, high: 101, low: 98, close: 99, volume: 200 }
    ], 'SELL', 'DOWN');

    expect(result).toMatchObject({
      confirmed: false,
      reason: 'VOLUME_SPIKE_ONLY_REJECTED'
    });
  });

  test('keeps a strong reversal plus volume spike eligible', () => {
    const loop = buildTradingLoop();
    loop.trigger = {
      period: 2,
      calculateBollingerBands: jest.fn(() => ({ lower: 90, upper: 110 })),
      getSourcePrice: jest.fn((candle) => Number(candle.close))
    };
    config.REJECT_VOLUME_ONLY_CONFIRMATION = true;

    const result = loop.checkOneMinuteConfirmation([
      { open: 99, high: 101, low: 98, close: 100, volume: 100 },
      { open: 100, high: 101, low: 96, close: 97, volume: 200 }
    ], 'SELL', 'DOWN');

    expect(result.confirmed).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining(['STRONG_REVERSAL_CANDLE', 'VOLUME_SPIKE']));
  });
});

describe('Full-alignment EMA ambush policy', () => {
  test('uses EMA readiness only when BTC, ETH and fresh 15m breadth align', () => {
    const loop = buildTradingLoop();
    const now = Date.now();
    const ambush = { expectedSignal: 'BUY', btcTrend: 'UP', ethTrend: 'UP' };
    const aligned = {
      calculatedAt: now,
      breadth15m: { state: 'UP' },
      breadth24h: { state: 'NEUTRAL' }
    };
    const neutral = {
      ...aligned,
      breadth15m: { state: 'NEUTRAL' }
    };

    expect(loop.isFullAlignmentForAmbush(ambush, aligned, now)).toBe(true);
    expect(loop.isFullAlignmentForAmbush(ambush, neutral, now)).toBe(false);
  });

  test('recognizes and clears an EMA-ready ambush when alignment is lost', () => {
    const loop = buildTradingLoop();
    const ambush = {
      ready: true,
      readyAt: 123,
      readyReason: 'EMA50_TOUCH_RECLAIM',
      readyRegime: 'FULL_ALIGNMENT_EMA'
    };

    expect(loop.isEmaReadyReason(ambush.readyReason)).toBe(true);
    loop.clearAmbushReadyState(ambush);
    expect(ambush).toMatchObject({
      ready: false,
      readyAt: null,
      readyReason: null,
      readyRegime: null
    });
  });

  test('fetches enough breadth candidates to retain 200 eligible coins', () => {
    const loop = buildTradingLoop();
    expect(loop.resolveBreadthCandidateFetchLimit(100)).toBe(400);
    expect(loop.resolveBreadthCandidateFetchLimit(600)).toBe(600);
  });
});

describe('Independent position monitoring', () => {
  test('resolves monitor interval from env when valid', () => {
    const original = process.env.POSITION_MONITOR_INTERVAL_MS;

    try {
      process.env.POSITION_MONITOR_INTERVAL_MS = '7000';
      const loop = buildTradingLoop();
      expect(loop.resolvePositionMonitorIntervalMs()).toBe(7000);
    } finally {
      process.env.POSITION_MONITOR_INTERVAL_MS = original;
    }
  });

  test('falls back to config monitor interval when env is invalid', () => {
    const originalEnv = process.env.POSITION_MONITOR_INTERVAL_MS;
    const originalConfig = config.POSITION_MONITOR_INTERVAL_MS;

    try {
      process.env.POSITION_MONITOR_INTERVAL_MS = '0';
      config.POSITION_MONITOR_INTERVAL_MS = 6500;
      const loop = buildTradingLoop();
      expect(loop.resolvePositionMonitorIntervalMs()).toBe(6500);
    } finally {
      process.env.POSITION_MONITOR_INTERVAL_MS = originalEnv;
      config.POSITION_MONITOR_INTERVAL_MS = originalConfig;
    }
  });

  test('skips unmanaged positions during monitor cycle', async () => {
    const loop = buildTradingLoop();
    loop.activePositions.set('BTCUSDT', {
      coin: 'BTCUSDT',
      ownership: 'UNMANAGED',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1
    });

    const lifecycleSpy = jest.spyOn(loop, 'syncPositionLifecycle').mockResolvedValue(null);

    await loop.monitorManagedPositions();

    expect(lifecycleSpy).not.toHaveBeenCalled();
  });

  test('processes bot-managed positions during monitor cycle', async () => {
    const loop = buildTradingLoop();
    loop.activePositions.set('BTCUSDT', {
      coin: 'BTCUSDT',
      ownership: 'BOT_CONFIRMED',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1,
      stopPrice: 95,
      takeProfitPrice: 105,
      beTriggerPercent: 0.6,
      trailingAtrMultiplier: 1
    });

    const lifecycleSpy = jest.spyOn(loop, 'syncPositionLifecycle').mockResolvedValue(null);

    await loop.monitorManagedPositions();

    expect(lifecycleSpy).toHaveBeenCalledTimes(1);
  });

  test('independent cycle exits when trading loop is not running', async () => {
    const loop = buildTradingLoop({
      services: {
        orderService: {
          isLiveTradingEnabled: jest.fn().mockReturnValue(true),
          getOpenPositions: jest.fn().mockResolvedValue([])
        }
      }
    });
    loop.running = false;

    await loop.runIndependentPositionMonitorCycle();

    expect(loop.orderService.getOpenPositions).not.toHaveBeenCalled();
  });

  test('independent cycle uses live positions and mark prices in live mode', async () => {
    const openPositions = [{ symbol: 'BTCUSDT', side: 'BUY', markPrice: 102.5, entryPrice: 100, quantity: 1 }];
    const loop = buildTradingLoop({
      services: {
        orderService: {
          isLiveTradingEnabled: jest.fn().mockReturnValue(true),
          getOpenPositions: jest.fn().mockResolvedValue(openPositions),
          primePositionRiskCycleCacheFromPositions: jest.fn(),
          primeOpenOrdersCycleCache: jest.fn().mockResolvedValue(undefined),
          clearPositionRiskCycleCache: jest.fn(),
          clearOpenOrdersCycleCache: jest.fn()
        }
      }
    });
    loop.running = true;

    const syncSpy = jest.spyOn(loop, 'syncManagedPositionsFromLivePositions').mockResolvedValue(undefined);
    const monitorSpy = jest.spyOn(loop, 'monitorManagedPositions').mockResolvedValue(undefined);

    await loop.runIndependentPositionMonitorCycle();

    expect(loop.orderService.primePositionRiskCycleCacheFromPositions).toHaveBeenCalledWith(openPositions);
    expect(loop.orderService.primeOpenOrdersCycleCache).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(openPositions);
    expect(monitorSpy).toHaveBeenCalledTimes(1);

    const monitorArg = monitorSpy.mock.calls[0][0];
    expect(monitorArg.skipLiveCachePriming).toBe(true);
    expect(monitorArg.livePriceByCoin.get('BTCUSDT')).toBeCloseTo(102.5, 10);
  });

  test('independent cycle delegates to managed monitor in non-live mode', async () => {
    const loop = buildTradingLoop();
    loop.running = true;

    const monitorSpy = jest.spyOn(loop, 'monitorManagedPositions').mockResolvedValue(undefined);

    await loop.runIndependentPositionMonitorCycle();

    expect(monitorSpy).toHaveBeenCalledTimes(1);
  });

  test('independent cycle tolerates live position fetch failure', async () => {
    const loop = buildTradingLoop({
      services: {
        orderService: {
          isLiveTradingEnabled: jest.fn().mockReturnValue(true),
          getOpenPositions: jest.fn().mockRejectedValue(new Error('FETCH_FAILED')),
          primePositionRiskCycleCacheFromPositions: jest.fn()
        }
      }
    });
    loop.running = true;

    await expect(loop.runIndependentPositionMonitorCycle()).resolves.toBeUndefined();
    expect(loop.orderService.primePositionRiskCycleCacheFromPositions).not.toHaveBeenCalled();
  });

  test('keeps existing bot-managed positions without re-verification', async () => {
    const loop = buildTradingLoop();
    loop.activePositions.set('BTCUSDT', {
      coin: 'BTCUSDT',
      symbol: 'BTCUSDT',
      signal: 'BUY',
      ownership: 'BOT_CONFIRMED',
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101,
      quantity: 1
    });

    await loop.syncManagedPositionsFromLivePositions([
      { symbol: 'BTCUSDT', side: 'BUY', entryPrice: 100, quantity: 1, leverage: 2, notional: 100 }
    ]);

    expect(loop.orderService.getOpenOrders).not.toHaveBeenCalled();
    expect(loop.activePositions.get('BTCUSDT').ownership).toBe('BOT_CONFIRMED');
  });

  test('skips unverified live positions during ownership sync', async () => {
    const loop = buildTradingLoop();
    jest.spyOn(loop, 'resolveLivePositionOwnership').mockResolvedValue({
      managed: false,
      reason: 'OWNERSHIP_UNVERIFIED'
    });

    await loop.syncManagedPositionsFromLivePositions([
      { symbol: 'ETHUSDT', side: 'SELL', entryPrice: 2000, quantity: 1, leverage: 2, notional: -2000 }
    ]);

    expect(loop.activePositions.has('ETHUSDT')).toBe(false);
  });

  test('treats missing ownership as unmanaged and performs no lifecycle action', async () => {
    const loop = buildTradingLoop();
    loop.activePositions.set('BTCUSDT', {
      coin: 'BTCUSDT',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1
    });
    const lifecycleSpy = jest.spyOn(loop, 'syncPositionLifecycle').mockResolvedValue(null);

    expect(loop.isPositionBotManaged(loop.activePositions.get('BTCUSDT'))).toBe(false);
    await loop.monitorManagedPositions();

    expect(lifecycleSpy).not.toHaveBeenCalled();
  });

  test('createPositionState defaults missing or ambiguous ownership to UNMANAGED', () => {
    const loop = buildTradingLoop();
    const base = {
      coin: 'BTCUSDT',
      signal: 'BUY',
      entryPrice: 100,
      stopPrice: 95,
      takeProfitPrice: 105,
      quantity: 1
    };

    expect(loop.createPositionState(base).ownership).toBe('UNMANAGED');
    expect(loop.createPositionState({ ...base, ownership: 'unknown' }).ownership).toBe('UNMANAGED');
    expect(loop.createPositionState({ ...base, ownership: 'BOT_CONFIRMED' }).ownership).toBe('BOT_CONFIRMED');
  });

  test('blocks direct stop replacement for an unverified position', async () => {
    const replaceStopLoss = jest.fn();
    const loop = buildTradingLoop({ services: { orderService: {
      isLiveTradingEnabled: jest.fn().mockReturnValue(false),
      replaceStopLoss
    } } });

    await expect(loop.replaceManagedStopLoss({
      coin: 'BTCUSDT',
      ownership: 'UNMANAGED',
      signal: 'BUY',
      stopOrderId: 'old-stop',
      quantity: 1
    }, 101)).rejects.toMatchObject({ code: 'POSITION_OWNERSHIP_UNVERIFIED' });

    expect(replaceStopLoss).not.toHaveBeenCalled();
  });

  test('updates state to the restored rollback order but does not apply the failed target stop', async () => {
    const rollbackError = new Error('replacement rejected');
    rollbackError.rollbackRestored = true;
    rollbackError.previousStopPrice = 95;
    rollbackError.rollbackResult = {
      orderId: 'rollback-stop',
      order: { stopPrice: 95 }
    };
    const loop = buildTradingLoop({ services: { orderService: {
      isLiveTradingEnabled: jest.fn().mockReturnValue(false),
      replaceStopLoss: jest.fn().mockRejectedValue(rollbackError)
    } } });
    const position = {
      coin: 'BTCUSDT',
      ownership: 'BOT_CONFIRMED',
      signal: 'BUY',
      stopOrderId: 'old-stop',
      stopPrice: 95,
      sl: 95,
      quantity: 1
    };

    await expect(loop.replaceManagedStopLoss(position, 101)).rejects.toBe(rollbackError);

    expect(position).toMatchObject({
      stopOrderId: 'rollback-stop',
      stopPrice: 95,
      sl: 95
    });
  });

  test('reattaches verified live positions during ownership sync', async () => {
    const loop = buildTradingLoop();
    jest.spyOn(loop, 'resolveLivePositionOwnership').mockResolvedValue({
      managed: true,
      reason: 'OWNERSHIP_VERIFIED'
    });
    jest.spyOn(loop, 'ensureProtectionOrdersWithRecovery').mockResolvedValue({ closed: false });
    jest.spyOn(loop, 'isBreakEvenActive').mockReturnValue(false);

    await loop.syncManagedPositionsFromLivePositions([
      { symbol: 'SOLUSDT', side: 'BUY', entryPrice: 120, quantity: 2, leverage: 2, notional: 240 }
    ]);

    expect(loop.activePositions.has('SOLUSDT')).toBe(true);
    expect(loop.activePositions.get('SOLUSDT').ownership).toBe('BOT_CONFIRMED');
  });
});

describe('Break-even and ATR trailing regression coverage', () => {
  test('keeps BE and trailing activation thresholds independent', () => {
    const loop = buildTradingLoop();
    const position = {
      entryPrice: 100,
      trailingActivationAtrMultiplier: 1.5
    };

    expect(loop.calculateBreakEvenTriggerPercent(position, 1, 1)).toBeCloseTo(1, 10);
    expect(loop.calculateTrailingActivationPercent(position, 1)).toBeCloseTo(1.5, 10);
  });

  test.each([
    ['BUY', 100.08, 'BE'],
    ['SELL', 99.92, 'BE']
  ])('classifies a rapid %s reversal at the commission-aware BE stop as BE', (signal, exitPrice, expected) => {
    const loop = buildTradingLoop();
    const position = {
      signal,
      entryPrice: 100,
      quantity: 1,
      tradeSizeUsdt: 100,
      tickSize: 0.01,
      stopPrice: exitPrice,
      breakEvenActivated: true,
      trailingActivated: false
    };

    expect(loop.determineCloseReason(position, { type: 'STOP_MARKET' }, exitPrice)).toBe(expected);
  });

  test.each([
    ['BUY', 101.5],
    ['SELL', 98.5]
  ])('classifies a profitable %s trailing stop independently from BE', (signal, exitPrice) => {
    const loop = buildTradingLoop();
    const position = {
      signal,
      entryPrice: 100,
      quantity: 1,
      tradeSizeUsdt: 100,
      tickSize: 0.01,
      stopPrice: exitPrice,
      breakEvenActivated: true,
      trailingActivationReached: true,
      trailingActivated: true
    };

    expect(loop.determineCloseReason(position, { type: 'STOP_MARKET' }, exitPrice)).toBe('TRAILING_TP');
  });

  test('counts normal TP and trailing exits in separate long/short counters', () => {
    const loop = buildTradingLoop();
    const base = {
      entryPrice: 100,
      quantity: 1,
      tradeSizeUsdt: 100,
      entryCommission: 0
    };

    loop.buildClosedPositionResult({ ...base, signal: 'BUY' }, 101, 'TP');
    loop.buildClosedPositionResult({ ...base, signal: 'SELL' }, 99, 'TRAILING_TP');

    expect(loop.tradeStats).toMatchObject({
      tpLong: 1,
      tpShort: 0,
      trailLong: 0,
      trailShort: 1
    });
  });

  test('counts a commission-negative TP as an economic loss while retaining the TP trigger', () => {
    const loop = buildTradingLoop();
    loop.commissionRate = 0.0004;
    const result = loop.buildClosedPositionResult({
      coin: 'TESTUSDT',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1,
      tradeSizeUsdt: 100,
      entryCommission: 0.04,
      highestPriceSinceEntry: 100.05,
      lowestPriceSinceEntry: 100
    }, 100.05, 'TP');

    expect(result.notification.reason).toBe('TP');
    expect(result.notification.netPnlForTradeSizeUsdt).toBeLessThan(0);
    expect(result.notification.economicOutcome).toBe('LOSS');
    expect(loop.tradeStats).toMatchObject({
      total: 1,
      successful: 0,
      failed: 1,
      neutral: 0,
      tp: 1,
      tpLong: 1,
      sl: 0
    });
  });

  test('does not classify an unfilled protective TP order as the live close cause', async () => {
    const getOrder = jest.fn(async (orderId) => ({
      id: orderId,
      type: orderId === 'tp-1' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
      status: 'CANCELED',
      stopPrice: orderId === 'tp-1' ? 102 : 98
    }));
    const loop = buildTradingLoop({
      services: {
        orderService: {
          getOrder,
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn()
        }
      }
    });
    loop.commissionRate = 0.0004;

    const result = await loop.finalizeLiveClosedPosition({
      coin: 'TESTUSDT',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1,
      tradeSizeUsdt: 100,
      entryCommission: 0.04,
      takeProfitOrderId: 'tp-1',
      stopOrderId: 'sl-1',
      highestPriceSinceEntry: 100,
      lowestPriceSinceEntry: 99
    }, 99);

    expect(result.notification.reason).toBe('EXTERNAL_CLOSE');
    expect(result.notification.economicOutcome).toBe('LOSS');
    expect(loop.tradeStats).toMatchObject({
      successful: 0,
      failed: 1,
      tp: 0,
      sl: 0,
      external: 1,
      externalLong: 1
    });
  });

  test('BE tolerance uses tick size and symbol precision instead of a fixed percentage', () => {
    const loop = buildTradingLoop();
    const tickPosition = {
      entryPrice: 100,
      quantity: 100,
      tradeSizeUsdt: 100,
      tickSize: 0.01
    };
    const precisionPosition = {
      entryPrice: 100.1234,
      quantity: 100,
      tradeSizeUsdt: 100,
      pricePrecision: 4
    };

    expect(loop.calculateBreakEvenTolerance(tickPosition)).toBe(0.01);
    expect(loop.resolvePriceStep(precisionPosition)).toBeCloseTo(0.0001, 12);
  });
});


describe('Quarter-hour closed-candle strategy scheduling', () => {
  test('schedules a pre-close startup just after the upcoming 15m close', () => {
    const originalDelay = process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS;

    try {
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = '5000';
      const loop = buildTradingLoop();
      const now = Date.parse('2026-07-31T16:14:50.000Z');

      expect(loop.calculateNextStrategyRunAt(now)).toBe(
        Date.parse('2026-07-31T16:15:05.000Z')
      );
    } finally {
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = originalDelay;
    }
  });

  test('schedules the next quarter when the current close delay has passed', () => {
    const originalDelay = process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS;

    try {
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = '5000';
      const loop = buildTradingLoop();
      const now = Date.parse('2026-07-31T16:15:06.000Z');

      expect(loop.calculateNextStrategyRunAt(now)).toBe(
        Date.parse('2026-07-31T16:30:05.000Z')
      );
    } finally {
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = originalDelay;
    }
  });

  test('runs the ambush monitor on its own interval', async () => {
    jest.useFakeTimers();
    const loop = buildTradingLoop();
    loop.running = true;
    const monitor = jest.spyOn(loop, 'runAmbushMonitorCycle').mockResolvedValue(undefined);

    loop.scheduleNextAmbushMonitorCycle(0);
    await jest.advanceTimersByTimeAsync(0);
    expect(monitor).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(loop.resolveAmbushMonitorIntervalMs());
    expect(monitor).toHaveBeenCalledTimes(2);
    loop.stop();
    jest.useRealTimers();
  });

  test('ambush monitor overlap guard skips a concurrent cycle', async () => {
    const loop = buildTradingLoop();
    loop.isAmbushMonitorCycleRunning = true;
    await expect(loop.runAmbushMonitorCycle()).resolves.toBeUndefined();
    expect(loop.isAmbushMonitorCycleRunning).toBe(true);
  });
});

describe('R32 live economic safety regression', () => {
  test('locks at least +0.35% after +1.00% favorable excursion regardless of R width', async () => {
    const loop = buildTradingLoop();
    const position = {
      coin: 'TESTUSDT',
      signal: 'BUY',
      entryPrice: 100,
      stopPrice: 95,
      highestPriceSinceEntry: 101.01,
      lowestPriceSinceEntry: 99,
      quantity: 1,
      tradeSizeUsdt: 100
    };
    loop.replaceManagedStopLoss = jest.fn(async (_position, stopPrice) => ({
      orderId: 'profit-floor-stop',
      order: { stopPrice }
    }));

    const activated = await loop.enforcePercentProfitFloor(position);

    expect(activated).toBe(true);
    expect(position.stopPrice).toBeCloseTo(100.35, 8);
    expect(loop.replaceManagedStopLoss).toHaveBeenCalledTimes(1);
  });

  test('caps a wide initial BUY stop at the configured hard maximum distance', () => {
    const loop = buildTradingLoop();
    const capped = loop.applyInitialStopSafetyCap(100, 'BUY', 95);
    expect(capped).toBeCloseTo(98.5, 8);
  });

  test('uses Binance user trades as LIVE close truth instead of mark-price fallback', async () => {
    const loop = buildTradingLoop({
      services: {
        orderService: {
          isLiveTradingEnabled: jest.fn().mockReturnValue(true),
          getUserTrades: jest.fn().mockResolvedValue([
            { id: 't1', orderId: 'o1', side: 'SELL', price: 101, quantity: 1, realizedPnl: 1, commission: 0.04, time: Date.now() }
          ]),
          getOrder: jest.fn().mockResolvedValue(null),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn()
        }
      }
    });
    const enteredAt = Date.now() - 1000;
    const result = await loop.finalizeLiveClosedPosition({
      coin: 'TESTUSDT',
      signal: 'BUY',
      entryPrice: 100,
      quantity: 1,
      executedQuantity: 1,
      tradeSizeUsdt: 100,
      entryCommission: 0.04,
      enteredAt,
      highestPriceSinceEntry: 101,
      lowestPriceSinceEntry: 99.5,
      takeProfitOrderId: null,
      stopOrderId: null
    }, 99);

    expect(result.closed).toBe(true);
    expect(result.notification.exitPrice).toBeCloseTo(101, 8);
    expect(result.notification.netPnlForTradeSizeUsdt).toBeCloseTo(0.92, 8);
    expect(result.notification.accountingSource).toBe('BINANCE_USER_TRADES');
    expect(result.notification.reason).toBe('EXTERNAL_CLOSE');
  });
});
