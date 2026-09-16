import {
  buildHistoricalReplayRecord,
  calculateForwardOutcomes,
  confirmHistoricalSetup,
  createReplayCohortReport,
  resolveHistoricalReplayPeriodEnd,
  resolveHistoricalReplayRunHash,
  summarizeReplayRecords
} from '../../src/research/st1-historical-replay.js';

const minute = 60_000;
const flowCandle = (closeTime, close, takerRatio = 0.7) => ({
  openTime: closeTime - minute + 1,
  closeTime,
  open: close,
  high: close + 0.05,
  low: close - 0.05,
  close,
  quoteVolume: 100,
  takerBuyQuoteVolume: 100 * takerRatio
});

describe('ST1 R43.2 historical replay', () => {
  test('pins a UTC period end and validates an explicit checkpoint hash', () => {
    expect(new Date(resolveHistoricalReplayPeriodEnd('2026-09-13')).toISOString())
      .toBe('2026-09-13T23:59:59.999Z');
    expect(resolveHistoricalReplayRunHash('D7AB2EEC0A9818C9')).toBe('d7ab2eec0a9818c9');
    expect(() => resolveHistoricalReplayPeriodEnd('2026-02-31')).toThrow('geçerli');
    expect(() => resolveHistoricalReplayRunHash('wrong-hash')).toThrow('hexadecimal');
  });

  test('replays reset, fresh cross and two closed 1m flow confirmations', () => {
    const readyAt = 1_000_000;
    const setup = {
      signal: 'BUY',
      targetPrice: 100,
      boxSize: 1,
      evaluatedAt: readyAt
    };
    const candles = [
      flowCandle(readyAt - minute, 99.8),
      flowCandle(readyAt + minute, 99.9),
      flowCandle(readyAt + (2 * minute), 100.1),
      flowCandle(readyAt + (3 * minute), 100.2)
    ];

    expect(confirmHistoricalSetup(setup, candles)).toMatchObject({
      confirmed: true,
      entryTime: readyAt + (3 * minute),
      entryPrice: 100.2,
      confirmationCount: 2
    });
  });

  test('calculates cost-adjusted fixed-horizon entry edge', () => {
    const outcomes = calculateForwardOutcomes({
      signal: 'BUY',
      entryTime: 0,
      entryPrice: 100,
      oneMinuteCandles: [
        { closeTime: minute, high: 100.5, low: 99.8, close: 100.2 },
        { closeTime: 2 * minute, high: 101, low: 100.1, close: 100.8 }
      ],
      horizonsMinutes: [2],
      roundTripCostPercent: 0.13,
      notionalUsdt: 50
    });

    expect(outcomes[2]).toMatchObject({
      grossReturnPercent: 0.8,
      netReturnPercent: 0.67,
      netPnlUsdt: 0.335,
      mfePercent: 1,
      maePercent: -0.2
    });
  });

  test('classifies candidates and requires robust promotion checks', () => {
    const baseRecord = buildHistoricalReplayRecord({
      symbol: 'TESTUSDT',
      setup: { signal: 'BUY', setupCloseTime: 1, evaluatedAt: 1, rsi: 29, boxSize: 1, targetPrice: 100 },
      confirmation: { entryTime: 2, entryPrice: 100, takerBuyRatio: 0.64, normalizedDelta: 0.28 },
      oneMinuteCandles: [
        { closeTime: minute, high: 101, low: 100, close: 100.5 }
      ],
      horizonsMinutes: [1],
      roundTripCostPercent: 0.13,
      notionalUsdt: 50
    });
    expect(baseRecord.candidates).toMatchObject({ rsiNear: true, longFlowBand: true, longRsiFlow: true });

    const records = Array.from({ length: 30 }, (_, index) => ({
      ...baseRecord,
      entryTime: index,
      outcomes: { 240: { netPnlUsdt: index % 3 === 0 ? -0.1 : 0.2 } }
    }));
    const summary = summarizeReplayRecords(records, 240);
    expect(summary).toMatchObject({ trades: 30, wins: 20, losses: 10 });
    expect(summary.profitFactor).toBe(4);
    expect(summary.promotionChecks).toEqual({
      minimumTrades30: true,
      profitFactorAtLeast1_25: true,
      bothHalvesPositive: true,
      bestTradeRemovedPositive: true
    });
    expect(createReplayCohortReport(records, { horizonMinutes: 240 }).all.longRsiFlow.trades).toBe(30);
  });
});
