import { jest } from '@jest/globals';
import HistoricalCandleCache from '../../src/cache/historical-candle-cache.js';
import config from '../../src/config/config.js';

describe('Historical candle cache default preload requests', () => {
  const originalSimilarityInterval = process.env.SIMILARITY_INTERVAL;
  const originalTrendInterval = process.env.BTC_TREND_INTERVAL;
  const originalSimilarityWindow = process.env.SIMILARITY_WINDOW_SIZE;
  const originalGlobalMin = process.env.HISTORICAL_CACHE_MIN_CANDLES;
  const originalTrendCandleLimitEnv = process.env.BTC_TREND_CANDLE_LIMIT;

  const originalFast = config.BTC_TREND_EMA_FAST_PERIOD;
  const originalSlow = config.BTC_TREND_EMA_SLOW_PERIOD;
  const originalTrendLimit = config.BTC_TREND_CANDLE_LIMIT;

  beforeEach(() => {
    process.env.SIMILARITY_INTERVAL = '15m';
    process.env.BTC_TREND_INTERVAL = '15m';
    process.env.SIMILARITY_WINDOW_SIZE = '120';
    process.env.HISTORICAL_CACHE_MIN_CANDLES = '0';

    config.BTC_TREND_EMA_FAST_PERIOD = 10;
    config.BTC_TREND_EMA_SLOW_PERIOD = 20;
  });

  afterAll(() => {
    process.env.SIMILARITY_INTERVAL = originalSimilarityInterval;
    process.env.BTC_TREND_INTERVAL = originalTrendInterval;
    process.env.SIMILARITY_WINDOW_SIZE = originalSimilarityWindow;
    process.env.HISTORICAL_CACHE_MIN_CANDLES = originalGlobalMin;
    process.env.BTC_TREND_CANDLE_LIMIT = originalTrendCandleLimitEnv;

    config.BTC_TREND_EMA_FAST_PERIOD = originalFast;
    config.BTC_TREND_EMA_SLOW_PERIOD = originalSlow;
    config.BTC_TREND_CANDLE_LIMIT = originalTrendLimit;
  });

  test('H) dedupes when trend and similarity interval+limit are identical', () => {
    config.BTC_TREND_CANDLE_LIMIT = 120;
    process.env.BTC_TREND_CANDLE_LIMIT = '120';

    const cache = new HistoricalCandleCache({ getKlines: jest.fn() });
    const requests = cache.getDefaultRequests();

    const sameIntervalLimit = requests.filter((request) => request.interval === '15m' && request.limit === 120);
    expect(sameIntervalLimit.length).toBe(1);
  });

  test('H) keeps both requests when interval is same but limit differs', () => {
    config.BTC_TREND_CANDLE_LIMIT = 300;
    process.env.BTC_TREND_CANDLE_LIMIT = '300';

    const cache = new HistoricalCandleCache({ getKlines: jest.fn() });
    const requests = cache.getDefaultRequests();

    const fifteenMinuteRequests = requests.filter((request) => request.interval === '15m');
    const limits = fifteenMinuteRequests.map((request) => request.limit).sort((a, b) => a - b);

    expect(limits).toContain(120);
    expect(limits).toContain(300);
  });
});
