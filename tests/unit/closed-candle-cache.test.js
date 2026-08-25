import { jest } from '@jest/globals';
import { HistoricalCandleCache } from '../../src/cache/historical-candle-cache.js';

describe('Historical candle cache closed-candle invariant', () => {
  test('removes every candle whose close time is still in the future', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const cache = new HistoricalCandleCache({ getKlines: jest.fn() });

    try {
      cache.setCandles('BTCUSDT', '15m', [
        { openTime: 1, closeTime: 999, close: 100 },
        { openTime: 2, closeTime: 1_000, close: 101 },
        { openTime: 3, closeTime: 1_001, close: 102 }
      ]);

      expect(cache.getCandles('BTCUSDT', '15m')).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('never returns an open candle from an initial fetch', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const marketData = {
      getKlines: jest.fn().mockResolvedValue([
        { openTime: 1, closeTime: 9_000, close: 100 },
        { openTime: 2, closeTime: 10_000, close: 101 },
        { openTime: 3, closeTime: 10_001, close: 102 }
      ])
    };
    const cache = new HistoricalCandleCache(marketData);

    try {
      const candles = await cache.getOrFetchCandles('BTCUSDT', '15m', 2);
      expect(candles.map(candle => candle.openTime)).toEqual([1, 2]);
      expect(candles.every(candle => candle.closeTime <= Date.now())).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
