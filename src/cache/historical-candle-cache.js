import logger from '../services/logger.js';
import config from '../config/config.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';
const DEFAULT_SIMILARITY_INTERVAL = '4h';
const DEFAULT_READY_TRIGGER_INTERVAL = '15m';
const DEFAULT_ONE_MIN_INTERVAL = '1m';
const DEFAULT_TOP_COINS_COUNT = 100;

class HistoricalCandleCache {
  constructor(marketDataService) {
    this.marketData = marketDataService;
    this.cache = new Map();
    this.lastPreloadMeta = null;
  }

  getDefaultRequests() {
    const similarityInterval = process.env.SIMILARITY_INTERVAL || DEFAULT_SIMILARITY_INTERVAL;
    const trendInterval = process.env.BTC_TREND_INTERVAL || config.BTC_TREND_INTERVAL || '15m';
    const readyTriggerInterval = process.env.READY_BOLLINGER_INTERVAL || DEFAULT_READY_TRIGGER_INTERVAL;
    const similarityPreloadHint = config.SIMILARITY_WINDOW_SIZE;

    const trendRequiredCandles = Math.max(
      Number(config.BTC_TREND_EMA_FAST_PERIOD || 50),
      Number(config.BTC_TREND_EMA_SLOW_PERIOD || 200)
    ) + 1;
    const trendLimit = Math.max(
      trendRequiredCandles,
      Number(process.env.BTC_TREND_CANDLE_LIMIT || config.BTC_TREND_CANDLE_LIMIT || trendRequiredCandles)
    );

    const requests = [
      { interval: trendInterval, limit: this.resolveTargetLimit(trendInterval, trendLimit) },
      { interval: similarityInterval, limit: this.resolveTargetLimit(similarityInterval, similarityPreloadHint) },
      { interval: readyTriggerInterval, limit: this.resolveMinimumRequiredLimit(readyTriggerInterval) },
      { interval: DEFAULT_ONE_MIN_INTERVAL, limit: this.resolveMinimumRequiredLimit(DEFAULT_ONE_MIN_INTERVAL) }
    ];

    const uniqueRequests = [];
    const seen = new Set();
    for (const request of requests) {
      const key = `${request.interval}::${request.limit}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueRequests.push(request);
    }

    return uniqueRequests;
  }

  async preloadOnStartup() {
    const topCoinLimit = parseInt(process.env.TOP_COINS_COUNT || String(DEFAULT_TOP_COINS_COUNT), 10);
    const topCoins = await this.marketData.getTop100Coins(topCoinLimit);
    const symbols = ['BTCUSDT', ...topCoins.map((coin) => coin.symbol)];

    return this.preloadForSymbols(symbols, this.getDefaultRequests());
  }

  async preloadForSymbols(symbols, requests) {
    const uniqueSymbols = [...new Set((symbols || []).filter(Boolean))];
    const normalizedRequests = (requests || [])
      .filter((request) => request && request.interval && Number(request.limit) > 0)
      .map((request) => ({
        interval: String(request.interval),
        limit: Number(request.limit)
      }));

    if (uniqueSymbols.length === 0 || normalizedRequests.length === 0) {
      this.lastPreloadMeta = {
        at: Date.now(),
        symbols: 0,
        requests: 0,
        fetched: 0,
        failed: 0
      };
      return this.lastPreloadMeta;
    }

    let fetched = 0;
    let failed = 0;
    let skipped = 0;
    const startedAt = Date.now();

    logger.info('🧠 Historical candle cache preload started', {
      symbols: uniqueSymbols.length,
      requests: normalizedRequests
    });

    for (const symbol of uniqueSymbols) {
      for (const request of normalizedRequests) {
        try {
          const cachedCandles = this.getCandles(symbol, request.interval);
          const targetLimit = this.resolveTargetLimit(request.interval, request.limit, cachedCandles.length);
          if (cachedCandles.length >= targetLimit) {
            skipped += 1;
            continue;
          }
          const candles = await this.marketData.getKlines(symbol, request.interval, targetLimit);
          this.setCandles(symbol, request.interval, candles);
          fetched += 1;
        } catch (error) {
          failed += 1;
          logger.warning('Historical candle cache fetch failed', {
            symbol,
            interval: request.interval,
            limit: request.limit,
            error: error.message
          });
        }
      }
    }

    this.lastPreloadMeta = {
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      symbols: uniqueSymbols.length,
      requests: normalizedRequests.length,
      fetched,
      skipped,
      failed
    };

    logger.info('✅ Historical candle cache preload completed', this.lastPreloadMeta);

    return this.lastPreloadMeta;
  }

  setCandles(symbol, interval, candles) {
    const key = this.getKey(symbol, interval);
    this.cache.set(key, this.filterClosedCandles(candles));
  }

  async getOrFetchCandles(symbol, interval, limit = null) {
    const safeLimit = limit == null ? null : Math.max(0, Number(limit) || 0);
    const cachedCandles = this.getCandles(symbol, interval);
    const targetLimit = this.resolveTargetLimit(interval, safeLimit, cachedCandles.length);

    if (cachedCandles.length > 0) {
      const hasEnoughCandles = cachedCandles.length >= targetLimit;
      if (hasEnoughCandles && !this.shouldRefresh(interval, cachedCandles)) {
        return this.sliceForRequest(cachedCandles, safeLimit);
      }

      if (hasEnoughCandles && this.shouldRefresh(interval, cachedCandles)) {
        const latestCandles = await this.marketData.getKlines(symbol, interval, 2);
        const updated = this.appendLatestClosedCandle(cachedCandles, latestCandles, targetLimit);
        this.setCandles(symbol, interval, updated);
        return this.sliceForRequest(updated, safeLimit);
      }
    }

    const fetchLimit = Math.max(1, targetLimit);
    const fetchedCandles = await this.marketData.getKlines(symbol, interval, fetchLimit);
    const normalizedFetched = this.filterClosedCandles(fetchedCandles).slice(-fetchLimit);
    this.setCandles(symbol, interval, normalizedFetched);
    return this.sliceForRequest(normalizedFetched, safeLimit);
  }

  getCandles(symbol, interval, limit = null) {
    const key = this.getKey(symbol, interval);
    const candles = this.filterClosedCandles(this.cache.get(key) || []);
    if (limit == null) {
      return candles;
    }
    const safeLimit = Math.max(0, Number(limit) || 0);
    if (safeLimit === 0) {
      return [];
    }
    return candles.slice(-safeLimit);
  }

  hasCandles(symbol, interval) {
    return this.cache.has(this.getKey(symbol, interval));
  }

  deleteCandles(symbol, interval) {
    this.cache.delete(this.getKey(symbol, interval));
  }

  clear() {
    this.cache.clear();
    this.lastPreloadMeta = null;
  }

  getStats() {
    return {
      entries: this.cache.size,
      lastPreloadMeta: this.lastPreloadMeta
    };
  }

  getKey(symbol, interval) {
    return `${String(symbol).toUpperCase()}::${String(interval)}`;
  }

  shouldRefresh(interval, candles) {
    const intervalMs = this.getIntervalMs(interval);
    if (!intervalMs || !Array.isArray(candles) || candles.length === 0) {
      return false;
    }

    const last = candles[candles.length - 1];
    const lastCloseTime = Number(last?.closeTime || 0);
    if (!Number.isFinite(lastCloseTime) || lastCloseTime <= 0) {
      return false;
    }

    return Date.now() >= lastCloseTime + intervalMs;
  }

  mergeCandles(existingCandles, newCandles, maxSize) {
    const mergedMap = new Map();
    for (const candle of existingCandles || []) {
      mergedMap.set(Number(candle.openTime), candle);
    }
    for (const candle of newCandles || []) {
      mergedMap.set(Number(candle.openTime), candle);
    }

    const merged = this.filterClosedCandles(Array.from(mergedMap.values()))
      .filter((candle) => Number.isFinite(Number(candle.openTime)))
      .sort((a, b) => Number(a.openTime) - Number(b.openTime));

    return merged.slice(-Math.max(1, Number(maxSize) || merged.length));
  }

  appendLatestClosedCandle(existingCandles, latestCandles, maxSize) {
    const normalizedMaxSize = Math.max(1, Number(maxSize) || existingCandles.length || 1);
    const output = Array.isArray(existingCandles) ? [...existingCandles] : [];
    const latestClosed = this.extractLatestClosedCandle(latestCandles);

    if (!latestClosed) {
      return output.slice(-normalizedMaxSize);
    }

    const lastExisting = output[output.length - 1];
    const lastExistingOpenTime = Number(lastExisting?.openTime || 0);
    const latestOpenTime = Number(latestClosed.openTime || 0);

    if (!Number.isFinite(latestOpenTime) || latestOpenTime <= lastExistingOpenTime) {
      return output.slice(-normalizedMaxSize);
    }

    output.push(latestClosed);
    if (output.length > normalizedMaxSize) {
      output.shift();
    }

    return output;
  }

  filterClosedCandles(candles, now = Date.now()) {
    if (!Array.isArray(candles)) {
      return [];
    }

    return candles.filter((candle) => {
      const closeTime = Number(candle?.closeTime);
      return Number.isFinite(closeTime) && closeTime <= now;
    });
  }

  extractLatestClosedCandle(candles) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return null;
    }

    const now = Date.now();
    for (let i = candles.length - 1; i >= 0; i--) {
      const candle = candles[i];
      const closeTime = Number(candle?.closeTime || 0);
      if (Number.isFinite(closeTime) && closeTime <= now) {
        return candle;
      }
    }

    return null;
  }

  sliceForRequest(candles, safeLimit) {
    if (safeLimit == null) {
      return candles;
    }
    return candles.slice(-safeLimit);
  }

  resolveTargetLimit(interval, requestedLimit, currentLength = 0) {
    const minimumRequired = this.resolveMinimumRequiredLimit(interval);
    const requested = requestedLimit == null ? 0 : Math.max(0, Number(requestedLimit) || 0);
    const existing = Math.max(0, Number(currentLength) || 0);
    return Math.max(1, minimumRequired, requested, existing);
  }

  resolveMinimumRequiredLimit(interval) {
    const similarityInterval = (process.env.SIMILARITY_INTERVAL || DEFAULT_SIMILARITY_INTERVAL).toLowerCase();
    const readyTriggerInterval = (process.env.READY_BOLLINGER_INTERVAL || DEFAULT_READY_TRIGGER_INTERVAL).toLowerCase();
    const normalizedInterval = String(interval || '').toLowerCase();

    const trendLookback = parseInt(process.env.BTC_TREND_LOOKBACK || '20', 10);
    const trendMaPeriod = parseInt(process.env.TREND_MA_PERIOD || String(TRADING_CONSTANTS.TREND_MA_PERIOD), 10);
    const adxPeriod = parseInt(process.env.ADX_PERIOD || '14', 10);
    const similarityWindow = parseInt(
      process.env.SIMILARITY_WINDOW_SIZE ||
      process.env.SIMILARITY_WINDOW ||
      String(TRADING_CONSTANTS.SIMILARITY_WINDOW_SIZE),
      10
    );
    const triggerPeriod = config.BOLLINGER_PERIOD;
    const rsiPeriod = parseInt(process.env.RSI_PERIOD || '14', 10);
    const atrPeriod = parseInt(process.env.ATR_PERIOD || String(TRADING_CONSTANTS.ATR_PERIOD), 10);
    const globalMin = parseInt(process.env.HISTORICAL_CACHE_MIN_CANDLES || '0', 10);

    if (normalizedInterval === similarityInterval) {
      return Math.max(globalMin, similarityWindow, trendLookback, trendMaPeriod, adxPeriod + 1);
    }

    if (normalizedInterval === readyTriggerInterval) {
      return Math.max(globalMin, triggerPeriod);
    }

    if (normalizedInterval === DEFAULT_ONE_MIN_INTERVAL) {
      return Math.max(globalMin, triggerPeriod, rsiPeriod + 2, atrPeriod + 1);
    }

    return Math.max(globalMin, 50);
  }

  getIntervalMs(interval) {
    const value = String(interval || '').trim().toLowerCase();
    if (!value) return null;

    const match = value.match(/^(\d+)([mhdw])$/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount <= 0) return null;

    if (unit === 'm') return amount * 60 * 1000;
    if (unit === 'h') return amount * 60 * 60 * 1000;
    if (unit === 'd') return amount * 24 * 60 * 60 * 1000;
    if (unit === 'w') return amount * 7 * 24 * 60 * 60 * 1000;
    return null;
  }
}

export { HistoricalCandleCache };
export default HistoricalCandleCache;
