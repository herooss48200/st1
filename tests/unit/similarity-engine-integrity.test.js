import { jest } from '@jest/globals';
import { SimilarityEngine } from '../../src/engines/similarity-engine.js';

const candles = (closes, options = {}) => closes.map((close, index) => {
  const open = options.opens?.[index] ?? (index === 0 ? close : closes[index - 1]);
  return {
    openTime: (options.offset || 0) + index * 60000,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1000 + index * 25,
    symbol: options.symbol || 'TEST'
  };
});

describe('SimilarityEngine metric integrity', () => {
  let engine;

  beforeEach(() => {
    engine = new SimilarityEngine();
    engine.window = 20;
  });

  test('aligns candles by actual timestamp instead of array index', async () => {
    const coin = candles([100, 101, 102, 103]);
    const reference = candles([99, 100, 101, 102]).slice(1);
    const result = await engine.analyzeSimilarity(coin, reference);

    expect(result.valid).toBe(true);
    expect(result.btcScores).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  test('rejects same-length windows when timestamps do not overlap', async () => {
    const result = await engine.analyzeSimilarity(
      candles([100, 101, 102]),
      candles([100, 101, 102], { offset: 999999 })
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('NO_TIMESTAMP_OVERLAP');
  });

  test('Pearson distinguishes correlated and inverse return paths', () => {
    const rising = candles([100, 102, 101, 104, 103, 106]);
    const similar = candles([50, 51, 50.5, 52, 51.5, 53]);
    const inverse = candles([100, 98, 99, 96, 97, 94]);

    expect(engine.calculatePearsonScore(rising, similar)).toBeGreaterThan(0.99);
    expect(engine.calculatePearsonScore(rising, inverse)).toBeLessThan(0.05);
  });

  test('body score accounts for candle direction', () => {
    const bullish = candles([100, 104], { opens: [100, 100] });
    const bearish = candles([100, 96], { opens: [100, 100] });

    expect(engine.calculateBodyScore(bullish, bullish)).toBe(1);
    expect(engine.calculateBodyScore(bullish, bearish)).toBeLessThanOrEqual(0.5);
  });

  test('momentum compares return magnitude as well as direction', () => {
    const strong = candles([100, 110, 120]);
    const weak = candles([100, 101, 102]);

    expect(engine.calculateMomentumScore(strong, weak)).toBeLessThan(0.25);
    expect(engine.calculateMomentumScore(strong, strong)).toBeCloseTo(1, 10);
  });

  test('trend is an independent regression-slope comparison', () => {
    const smoothUp = candles([100, 102, 104, 106, 108]);
    const lateSpike = candles([100, 100, 100, 100, 108]);

    expect(engine.calculateMomentumScore(smoothUp, lateSpike)).toBeCloseTo(1, 10);
    expect(engine.calculateTrendScore(smoothUp, lateSpike)).toBeLessThan(1);
  });

  test('pattern score compares candle classes and sequence', () => {
    const bullish = candles([100, 102, 104], { opens: [99, 100, 102] });
    const bearish = candles([100, 98, 96], { opens: [101, 100, 98] });

    expect(engine.calculatePatternScore(bullish, bullish)).toBe(1);
    expect(engine.calculatePatternScore(bullish, bearish)).toBe(0);
  });

  test('returns separate BTC and ETH metrics', async () => {
    const coin = candles([100, 101, 103, 102, 105]);
    const btc = candles([200, 202, 206, 204, 210], { symbol: 'BTCUSDT' });
    const eth = candles([50, 49, 51, 50, 52], { symbol: 'ETHUSDT' });
    const result = await engine.analyzeSimilarity(coin, btc, eth);

    expect(result.valid).toBe(true);
    expect(result.btcScores).toHaveProperty('pearson');
    expect(result.ethScores).toHaveProperty('pearson');
    expect(result.btcScores).not.toBe(result.ethScores);
  });

  test('unexpected metric exceptions fail closed without throwing', async () => {
    jest.spyOn(engine, 'calculateScores').mockImplementation(() => {
      throw new Error('synthetic failure');
    });

    await expect(engine.analyzeSimilarity(candles([100, 101]), candles([100, 101])))
      .resolves.toMatchObject({ valid: false, reason: 'SIMILARITY_CALCULATION_FAILED' });
  });
});
