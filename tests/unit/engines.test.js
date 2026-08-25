import similarityEngine from '../../src/engines/similarity-engine.js';
import trendEngine from '../../src/engines/trend-engine.js';
import triggerEngine from '../../src/engines/trigger-engine.js';

describe('Trading Engines', () => {
  const mockCandles = [
    { openTime: 1000, open: 100, high: 105, low: 95, close: 102, volume: 1000, symbol: 'TEST' },
    { openTime: 2000, open: 102, high: 108, low: 101, close: 105, volume: 1100, symbol: 'TEST' },
    { openTime: 3000, open: 105, high: 107, low: 102, close: 104, volume: 1050, symbol: 'TEST' }
  ];

  test('SimilarityEngine should analyze similarity', async () => {
    const result = await similarityEngine.analyzeSimilarity(
      mockCandles,
      mockCandles
    );
    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeCloseTo(1, 10);
  });

  test('SimilarityEngine should clamp weighted scores to the 0-1 range', () => {
    expect(similarityEngine.weightScores({
      pearson: 2,
      body: 2,
      wickUpper: 2,
      wickLower: 2,
      range: 2,
      volume: 2,
      momentum: 2,
      trend: 2,
      pattern: 2
    })).toBe(1);

    expect(similarityEngine.weightScores({
      pearson: -1,
      body: -1,
      wickUpper: -1,
      wickLower: -1,
      range: -1,
      volume: -1,
      momentum: -1,
      trend: -1,
      pattern: -1
    })).toBe(0);
  });

  test('TrendEngine should determine trend', async () => {
    const extended = Array(200).fill(0).map((_, i) => ({
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 1000
    }));

    const result = await trendEngine.analyzeTrend(extended);
    expect(result).toBeDefined();
    expect(['UP', 'DOWN', 'SIDEWAYS']).toContain(result.trend);
  });

  test('TrendEngine should fail closed below the slow EMA candle minimum', async () => {
    const insufficient = Array(199).fill(0).map((_, i) => ({
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 1000
    }));

    await expect(trendEngine.analyzeTrend(insufficient)).resolves.toEqual({
      trend: 'SIDEWAYS',
      confidence: 0
    });
  });

  test('TriggerEngine should detect Bollinger Band touches', async () => {
    const extended = Array(25).fill(0).map((_, i) => ({
      open: 100,
      high: 102,
      low: 98,
      close: 100 + (Math.sin(i) * 2),
      volume: 1000
    }));

    const result = await triggerEngine.analyzeTrigger(extended);
    expect(result).toBeDefined();
    expect(['LOWER_BAND', 'UPPER_BAND', null]).toContain(result.type);
  });

  test('TriggerEngine should require an EMA50 touch, aligned slope and reclaim for LONG', () => {
    const candles = Array.from({ length: 59 }, (_, index) => ({
      open: 100 + (index * 0.2),
      high: 100.5 + (index * 0.2),
      low: 99.5 + (index * 0.2),
      close: 100 + (index * 0.2),
      volume: 1000
    }));
    const previousEma = triggerEngine.calculateEMA(candles, 50);
    candles.push({
      open: 111.6,
      high: 112.2,
      low: previousEma,
      close: 111.8,
      volume: 1200
    });

    const result = triggerEngine.analyzeEmaTouch(candles, 'BUY', {
      emaPeriod: 50,
      atrPeriod: 14,
      touchAtrMultiplier: 0.10,
      requireReclaim: true,
      requireSlope: true
    });

    expect(result).toMatchObject({
      triggered: true,
      type: 'EMA50_TOUCH_RECLAIM',
      approachedFromCorrectSide: true,
      reclaimed: true,
      slopeAligned: true
    });
  });

  test('TriggerEngine should reject a LONG EMA50 breakdown without reclaim', () => {
    const candles = Array.from({ length: 59 }, (_, index) => ({
      open: 100 + (index * 0.2),
      high: 100.5 + (index * 0.2),
      low: 99.5 + (index * 0.2),
      close: 100 + (index * 0.2),
      volume: 1000
    }));
    const previousEma = triggerEngine.calculateEMA(candles, 50);
    candles.push({
      open: 111.6,
      high: previousEma + 0.1,
      low: previousEma - 2,
      close: previousEma - 1,
      volume: 1200
    });

    const result = triggerEngine.analyzeEmaTouch(candles, 'BUY', {
      emaPeriod: 50,
      atrPeriod: 14,
      touchAtrMultiplier: 0.10,
      requireReclaim: true,
      requireSlope: true
    });

    expect(result.triggered).toBe(false);
    expect(result.reclaimed).toBe(false);
  });
});
