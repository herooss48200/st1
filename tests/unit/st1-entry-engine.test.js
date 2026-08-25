import { jest } from '@jest/globals';
import triggerEngine from '../../src/engines/trigger-engine.js';
import { TradingLoop, preserveAmbushRuntimeState } from '../../src/trading-loop.js';
import config from '../../src/config/config.js';

function buildLoop() {
  return new TradingLoop({
    candleService: {},
    marketData: { getKlines: jest.fn().mockResolvedValue([]) },
    historicalCandleCache: { getOrFetchCandles: jest.fn().mockResolvedValue([]) },
    orderService: {
      isLiveTradingEnabled: jest.fn().mockReturnValue(false),
      getCurrentPrice: jest.fn().mockResolvedValue(100),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      primePositionRiskCycleCache: jest.fn(),
      primeOpenOrdersCycleCache: jest.fn(),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn(),
      primePositionRiskCycleCacheFromPositions: jest.fn()
    }
  }, {
    similarity: {},
    trend: {},
    trigger: triggerEngine,
    riskManager: {}
  });
}

function baselineCandles(count = 20, start = 1_000_000_000, intervalMs = 900_000) {
  return Array.from({ length: count }, (_, index) => ({
    openTime: start + (index * intervalMs),
    closeTime: start + ((index + 1) * intervalMs) - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000
  }));
}

describe('AGROS ST1 15m Bollinger setup engine', () => {
  test('LONG requires a red setup candle at/through/near the lower Bollinger band', () => {
    const candles = baselineCandles();
    candles.push({
      openTime: 1_000_000_000 + (20 * 900_000),
      closeTime: 1_000_000_000 + (21 * 900_000) - 1,
      open: 96,
      high: 97,
      low: 90,
      close: 94,
      volume: 1200
    });

    const result = triggerEngine.analyzeSt1BollingerSetup(candles, 'BUY', {
      atrPeriod: 14,
      touchAtrMultiplier: 0.10
    });

    expect(result.triggered).toBe(true);
    expect(result.type).toBe('ST1_LOWER_BB_RED_SETUP');
    expect(result.colorAligned).toBe(true);
    expect(result.bandTouchedOrApproached).toBe(true);
    expect(result.bodyBreakPrice).toBe(96);
  });

  test('SHORT requires a green setup candle at/through/near the upper Bollinger band', () => {
    const candles = baselineCandles();
    candles.push({
      openTime: 1_000_000_000 + (20 * 900_000),
      closeTime: 1_000_000_000 + (21 * 900_000) - 1,
      open: 104,
      high: 110,
      low: 103,
      close: 106,
      volume: 1200
    });

    const result = triggerEngine.analyzeSt1BollingerSetup(candles, 'SELL', {
      atrPeriod: 14,
      touchAtrMultiplier: 0.10
    });

    expect(result.triggered).toBe(true);
    expect(result.type).toBe('ST1_UPPER_BB_GREEN_SETUP');
    expect(result.bodyBreakPrice).toBe(104);
  });

  test('confirmation candle color is exact opposite of setup direction', () => {
    expect(triggerEngine.isSt1ConfirmationCandle({ open: 94, close: 95 }, 'BUY')).toBe(true);
    expect(triggerEngine.isSt1ConfirmationCandle({ open: 95, close: 94 }, 'BUY')).toBe(false);
    expect(triggerEngine.isSt1ConfirmationCandle({ open: 106, close: 105 }, 'SELL')).toBe(true);
    expect(triggerEngine.isSt1ConfirmationCandle({ open: 105, close: 106 }, 'SELL')).toBe(false);
  });
});

describe('AGROS ST1 3-candle body-break window', () => {
  test('arms LONG only after red lower-BB setup + next green closed confirmation', () => {
    const loop = buildLoop();
    const intervalMs = 900_000;
    const start = 1_000_000_000;
    const candles = baselineCandles(20, start, intervalMs);
    candles.push({
      openTime: start + (20 * intervalMs),
      closeTime: start + (21 * intervalMs) - 1,
      open: 96,
      high: 97,
      low: 90,
      close: 94,
      volume: 1200
    });
    candles.push({
      openTime: start + (21 * intervalMs),
      closeTime: start + (22 * intervalMs) - 1,
      open: 94,
      high: 96,
      low: 93,
      close: 95,
      volume: 1300
    });

    const now = candles.at(-1).closeTime + 1000;
    const setup = loop.findLatestSt1ConfirmedSetup(candles, 'BUY', now, '15m');

    expect(setup).not.toBeNull();
    expect(setup.bodyBreakPrice).toBe(96);
    expect(loop.getSt1EntryWindowCandleNumber(setup, now, '15m')).toBe(1);
    expect(loop.isSt1BodyBreakTriggered(setup, 96)).toBe(false);
    expect(loop.isSt1BodyBreakTriggered(setup, 96.0001)).toBe(true);
  });

  test('expires after the third post-confirmation 15m candle', () => {
    const loop = buildLoop();
    const intervalMs = 900_000;
    const start = 2_000_000_000;
    const candles = baselineCandles(20, start, intervalMs);
    candles.push({
      openTime: start + (20 * intervalMs),
      closeTime: start + (21 * intervalMs) - 1,
      open: 96,
      high: 97,
      low: 90,
      close: 94,
      volume: 1200
    });
    candles.push({
      openTime: start + (21 * intervalMs),
      closeTime: start + (22 * intervalMs) - 1,
      open: 94,
      high: 96,
      low: 93,
      close: 95,
      volume: 1300
    });

    const expiredAt = candles.at(-1).closeTime + (3 * intervalMs) + 1;
    expect(loop.findLatestSt1ConfirmedSetup(candles, 'BUY', expiredAt, '15m')).toBeNull();
  });

  test('SHORT body break is the strict move below the green setup body bottom', () => {
    const loop = buildLoop();
    const setup = { signal: 'SELL', bodyBreakPrice: 104 };
    expect(loop.isSt1BodyBreakTriggered(setup, 104)).toBe(false);
    expect(loop.isSt1BodyBreakTriggered(setup, 103.9999)).toBe(true);
  });

  test('ignores an unclosed live candle and keeps the last fully confirmed setup active', () => {
    const loop = buildLoop();
    const intervalMs = 900_000;
    const start = 3_000_000_000;
    const candles = baselineCandles(20, start, intervalMs);
    candles.push({
      openTime: start + (20 * intervalMs),
      closeTime: start + (21 * intervalMs) - 1,
      open: 96, high: 97, low: 90, close: 94, volume: 1200
    });
    candles.push({
      openTime: start + (21 * intervalMs),
      closeTime: start + (22 * intervalMs) - 1,
      open: 94, high: 96, low: 93, close: 95, volume: 1300
    });

    const now = start + (22 * intervalMs) + 30_000;
    candles.push({
      openTime: start + (22 * intervalMs),
      closeTime: start + (23 * intervalMs) - 1,
      open: 95, high: 97, low: 94, close: 96.5, volume: 500
    });

    const setup = loop.findLatestSt1ConfirmedSetup(candles, 'BUY', now, '15m');
    expect(setup).not.toBeNull();
    expect(setup.setupOpen).toBe(96);
    expect(setup.confirmationClose).toBe(95);
    expect(loop.getSt1EntryWindowCandleNumber(setup, now, '15m')).toBe(1);
  });
});

describe('AGROS ST1 coin EMA50/EMA200 + SuperTrend gate', () => {
  test('accepts rising LONG structure', () => {
    const loop = buildLoop();
    const candles = Array.from({ length: 240 }, (_, index) => {
      const close = 100 + (index * 0.5);
      return { open: close - 0.2, high: close + 0.6, low: close - 0.6, close, volume: 1000 };
    });
    const result = loop.evaluateSt1CoinDirection(candles, 'BUY');
    expect(result.allowed).toBe(true);
    expect(result.ema50).toBeGreaterThan(result.ema200);
    expect(result.supertrend).toBe('UP');
  });

  test('accepts falling SHORT structure', () => {
    const loop = buildLoop();
    const candles = Array.from({ length: 240 }, (_, index) => {
      const close = 300 - (index * 0.5);
      return { open: close + 0.2, high: close + 0.6, low: close - 0.6, close, volume: 1000 };
    });
    const result = loop.evaluateSt1CoinDirection(candles, 'SELL');
    expect(result.allowed).toBe(true);
    expect(result.ema50).toBeLessThan(result.ema200);
    expect(result.supertrend).toBe('DOWN');
  });
});

describe('ST1 runtime state survives 15m ambush refresh', () => {
  test('preserves the active setup while direction stays the same', () => {
    const previous = {
      expectedSignal: 'BUY',
      triggered: false,
      addedAt: 123,
      ready: true,
      readyAt: 456,
      readyReason: 'ST1_LOWER_BB_RED_GREEN_CONFIRM',
      readyRegime: 'ST1_BB_15M_BODY_BREAK',
      st1Setup: { bodyBreakPrice: 96, entryWindowEndAt: 999 },
      st1LastFilterReason: 'ST1_COIN_SUPERTREND_MISMATCH'
    };
    const next = {
      expectedSignal: 'BUY',
      triggered: false,
      addedAt: 777,
      ready: false,
      readyAt: null,
      readyReason: null
    };

    const merged = preserveAmbushRuntimeState(next, previous);
    expect(merged.addedAt).toBe(123);
    expect(merged.st1Setup).toEqual(previous.st1Setup);
    expect(merged.st1LastFilterReason).toBe('ST1_COIN_SUPERTREND_MISMATCH');
  });
});

describe('ST1 policy defaults', () => {
  test('uses requested 15m three-candle EMA50/200 and SuperTrend policy', () => {
    expect(config.ST1_ENTRY_ENGINE_ENABLED).toBe(true);
    expect(config.ST1_ENTRY_WINDOW_CANDLES).toBe(3);
    expect(config.ST1_COIN_EMA_FAST_PERIOD).toBe(50);
    expect(config.ST1_COIN_EMA_SLOW_PERIOD).toBe(200);
    expect(config.ST1_COIN_SUPERTREND_PERIOD).toBe(10);
    expect(config.ST1_COIN_SUPERTREND_MULTIPLIER).toBe(3);
  });
});
