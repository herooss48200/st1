import logger from './logger.js';
import axios from 'axios';
import config from '../config/config.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';

class MarketDataService {
  constructor() {
    this.btcCandles = [];
    this.coinCandles = {};
    this.marketData = {};
    this.updateInterval = TRADING_CONSTANTS.DATA_SYNC_INTERVAL_MS;
    this.historicalCandleCache = null;
    this.inFlightKlines = new Map();
    this.activeKlineRequests = 0;
    this.klineWaiters = [];
    this.candleFailureCount = 0;
    this.candleCircuitOpenUntil = 0;
  }

  async initialize() {
    logger.info('Market Data Service initialized');
  }

  setHistoricalCandleCache(historicalCandleCache) {
    this.historicalCandleCache = historicalCandleCache;
  }

  async getKlines(symbol, interval, limit = 500) {
    const requestedLimit = Math.max(1, Number(limit) || 1);
    const requestKey = `${String(symbol).toUpperCase()}::${interval}::${requestedLimit}`;
    if (this.inFlightKlines.has(requestKey)) {
      return this.inFlightKlines.get(requestKey);
    }

    const request = this.withKlinePermit(() => this.fetchKlinesWithRetry(symbol, interval, requestedLimit))
      .finally(() => this.inFlightKlines.delete(requestKey));
    this.inFlightKlines.set(requestKey, request);
    return request;
  }

  async withKlinePermit(task) {
    const concurrency = Math.max(1, Number(config.CANDLE_REQUEST_CONCURRENCY));
    if (this.activeKlineRequests >= concurrency) {
      await new Promise((resolve) => this.klineWaiters.push(resolve));
    }
    this.activeKlineRequests += 1;
    try {
      return await task();
    } finally {
      this.activeKlineRequests -= 1;
      this.klineWaiters.shift()?.();
    }
  }

  async fetchKlinesWithRetry(symbol, interval, requestedLimit) {
    if (Date.now() < this.candleCircuitOpenUntil) {
      const error = new Error('CANDLE_CIRCUIT_OPEN');
      error.code = 'CANDLE_CIRCUIT_OPEN';
      throw error;
    }

    const attempts = Math.max(1, Number(config.CANDLE_RETRY_ATTEMPTS));
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const candles = await this.fetchKlinesOnce(symbol, interval, requestedLimit, attempt);
        this.candleFailureCount = 0;
        this.candleCircuitOpenUntil = 0;
        return candles;
      } catch (error) {
        lastError = error;
        this.candleFailureCount += 1;
        if (this.candleFailureCount >= Number(config.CANDLE_CIRCUIT_FAILURE_THRESHOLD)) {
          this.candleCircuitOpenUntil = Date.now() + Number(config.CANDLE_CIRCUIT_OPEN_MS);
        }
        if (attempt < attempts && this.isRetryableCandleError(error)) {
          const retryAfterSeconds = Number(error.response?.headers?.['retry-after']);
          const baseDelay = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : Number(config.CANDLE_RETRY_BASE_DELAY_MS) * (2 ** (attempt - 1));
          const jitter = Math.floor(Math.random() * Math.max(1, baseDelay * 0.2));
          await this.delay(baseDelay + jitter);
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

  isRetryableCandleError(error) {
    const status = Number(error.response?.status || 0);
    return status === 429 || status >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetchKlinesOnce(symbol, interval, requestedLimit, attempt) {
    try {
      logger.info(`Fetching ${symbol} ${interval} candles (${requestedLimit})...`);
      const baseUrl = config.getBinanceUrl();
      const fetchLimit = Math.min(1500, requestedLimit + 1);
      const response = await axios.get(`${baseUrl}/fapi/v1/klines`, {
        params: { symbol, interval, limit: fetchLimit },
        timeout: config.MARKET_DATA_REQUEST_TIMEOUT_MS
      });
      const now = Date.now();

      return response.data.map(candle => ({
        symbol,
        openTime: Number(candle[0]),
        closeTime: Number(candle[6]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        quoteVolume: parseFloat(candle[7]),
        trades: Number(candle[8]),
        takerBuyVolume: parseFloat(candle[9]),
        takerBuyQuoteVolume: parseFloat(candle[10])
      }))
        .filter(candle => Number.isFinite(candle.closeTime) && candle.closeTime <= now)
        .slice(-requestedLimit);
    } catch (error) {
      logger.error(`Failed to fetch ${symbol} ${interval} candles`, {
        error: error.message,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        attempt,
        requestId: error.response?.headers?.['x-request-id'] || error.response?.headers?.['x-mbx-uuid'] || null,
        endpoint: error.config?.url || null
      });
      throw error;
    }
  }

  async fetchBTCCandles() {
    try {
      logger.info('Fetching BTC 4H candles...');
      this.btcCandles = await this.historicalCandleCache.getOrFetchCandles(
        config.BTC_SYMBOL,
        process.env.MARKET_DATA_INTERVAL_1H || '1h',
        Number.parseInt(process.env.MARKET_DATA_FETCH_LIMIT, 10) || 1000
      );
      return this.btcCandles;
    } catch (error) {
      logger.error('Failed to fetch BTC candles', { error: error.message });
      throw error;
    }
  }

  async fetchCoinCandles(symbol) {
    try {
      if (!this.coinCandles[symbol]) {
        this.coinCandles[symbol] = await this.historicalCandleCache.getOrFetchCandles(symbol, '1h', 500);
      }
      return this.coinCandles[symbol];
    } catch (error) {
      logger.error(`Failed to fetch ${symbol} candles`, { error: error.message });
      throw error;
    }
  }

  async getTop100Coins(limit = 300) {
    try {
      logger.info('Fetching top coins by volume...', { limit });
      const baseUrl = config.getBinanceUrl();
      const response = await axios.get(`${baseUrl}/fapi/v1/ticker/24hr`, {
        timeout: config.MARKET_DATA_REQUEST_TIMEOUT_MS
      });
      const tickers = Array.isArray(response.data) ? response.data : [];

      return tickers
        .filter(ticker => ticker.symbol.endsWith('USDT') && ticker.symbol !== 'BTCUSDT')
        .map(ticker => ({
          symbol: ticker.symbol,
          volume24h: parseFloat(ticker.quoteVolume || '0'),
          priceChangePercent: parseFloat(ticker.priceChangePercent || '0')
        }))
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, Math.max(1, limit))
        .map((ticker, index) => ({
          ...ticker,
          rank: index + 1
        }));
    } catch (error) {
      logger.error('Failed to fetch top coins', { error: error.message, limit });
      throw error;
    }
  }
}

export { MarketDataService };
export default new MarketDataService();
