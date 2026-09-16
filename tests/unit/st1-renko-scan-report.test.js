import { jest } from '@jest/globals';
import { TradingLoop } from '../../src/trading-loop.js';

function closedFlatCandles(now, count = 40) {
  const intervalMs = 15 * 60 * 1000;
  const start = now - ((count + 1) * intervalMs);
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

function buildLoop(now) {
  const candles = closedFlatCandles(now);
  return new TradingLoop({
    candleService: {},
    marketData: {
      getTop100Coins: jest.fn().mockResolvedValue([
        { symbol: 'AAAUSDT' },
        { symbol: 'BBBUSDT' }
      ]),
      getKlines: jest.fn().mockResolvedValue(candles)
    },
    historicalCandleCache: {
      getOrFetchCandles: jest.fn().mockResolvedValue(candles)
    },
    orderService: {
      isLiveTradingEnabled: jest.fn().mockReturnValue(false),
      getCurrentPrice: jest.fn().mockResolvedValue(100),
      clearPositionRiskCycleCache: jest.fn(),
      clearOpenOrdersCycleCache: jest.fn()
    }
  }, {
    similarity: {},
    trend: {},
    trigger: {},
    riskManager: {}
  });
}

describe('ST1 R43.1 real Renko scan reporting', () => {
  test('does not report the universe as scanned before Renko analysis runs', async () => {
    const now = Date.now();
    const loop = buildLoop(now);
    loop.notifyAmbushScanResult = jest.fn().mockResolvedValue(undefined);

    await loop.refreshSimpleRenkoUniverse(now);

    expect(loop.simpleRenkoUniverse).toHaveLength(2);
    expect(loop.simpleRenkoPendingScan).toMatchObject({
      refreshAt: now,
      fetchedCoins: 2
    });
    expect(loop.notifyAmbushScanResult).not.toHaveBeenCalled();
  });

  test('reports actual analyzed count and rejection reasons after the full cycle', async () => {
    const now = Date.now();
    const loop = buildLoop(now);
    loop.notifyAmbushScanResult = jest.fn().mockResolvedValue(undefined);

    await loop.refreshSimpleRenkoUniverse(now);
    await loop.runSimpleRenkoEntryCycle({ opened: [], closed: [] }, now, Number.POSITIVE_INFINITY);

    expect(loop.notifyAmbushScanResult).toHaveBeenCalledTimes(1);
    const payload = loop.notifyAmbushScanResult.mock.calls[0][0];
    expect(payload).toMatchObject({
      strategy: 'ST1_SIMPLE_RENKO',
      status: 'COMPLETED',
      reason: 'ST1_SIMPLE_RENKO_ANALYSIS_COMPLETE',
      fetchedCoins: 2,
      scannedCoins: 2,
      qualifiedAmbushes: 0,
      ambushCount: 0,
      longCount: 0,
      shortCount: 0,
      candleFailures: 0,
      activePositionSkips: 0,
      rejectionCounts: {
        ST1_RENKO_DATA_INSUFFICIENT: 2
      }
    });
    expect(loop.simpleRenkoPendingScan).toBeNull();
  });

  test('entry funnel snapshot exposes R43.3 crossing, flow and scientific gate stages', () => {
    const loop = buildLoop(Date.now());
    loop.markEntryFunnelStage('BUY', 'freshCross', 'AAAUSDT');
    loop.markEntryFunnelStage('BUY', 'orderFlow1', 'AAAUSDT');
    loop.markEntryFunnelStage('BUY', 'orderFlow2', 'AAAUSDT');
    loop.markEntryFunnelStage('BUY', 'scientificGate', 'AAAUSDT');

    const snapshot = loop.getEntryFunnelSnapshot();
    expect(snapshot.LONG).toMatchObject({
      freshCross: 1,
      orderFlow1: 1,
      orderFlow2: 1,
      scientificGate: 1
    });
    expect(snapshot.SHORT).toMatchObject({
      freshCross: 0,
      orderFlow1: 0,
      orderFlow2: 0,
      scientificGate: 0
    });
  });
});
