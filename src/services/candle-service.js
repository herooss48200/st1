import logger from './logger.js';
import { EventBus } from '../core/event-bus.js';
import config from '../config/config.js';

const eventBus = EventBus.getInstance ? EventBus.getInstance() : EventBus.default || EventBus;

export class CandleService {
  constructor(marketDataService, candleRepo) {
    this.marketData = marketDataService;
    this.candleRepo = candleRepo;
    this.btcCandles1h = [];
    this.coinCandles1m = new Map();
    this.monitoring = false;
  }

  async startMonitoring() {
    this.monitoring = true;
    logger.info('Candle Service started monitoring');

    eventBus.on('kline', (kline) => {
      if (kline.interval === '1m' && kline.isClosed) {
        if (this.candleRepo && typeof this.candleRepo.insert === 'function') {
          try {
            this.candleRepo.insert(kline);
          } catch (error) {
            logger.warning('Candle repository insert failed', {
              symbol: kline.symbol,
              interval: kline.interval,
              error: error.message
            });
          }
        }
        this.coinCandles1m.set(kline.symbol, kline);
        eventBus.emit('candle-1m', kline);
      }
    });

    setInterval(() => this.collectBTC1h(), config.CANDLE_COLLECTION_INTERVAL_MS);
  }

  async collectBTC1h() {
    try {
      const candles = await this.marketData.fetchBTCCandles();
      this.btcCandles1h = candles;
      for (const c of candles) this.candleRepo.insert(c);
      logger.info(`Collected ${candles.length} BTC 1h candles`);
    } catch (err) {
      logger.error('BTC candle collection error:', err);
    }
  }

  getLatestCandle(symbol, interval) {
    if (interval === '1m') return this.coinCandles1m.get(symbol);
    if (interval === '1h' && symbol === 'BTCUSDT') {
      return this.btcCandles1h[this.btcCandles1h.length - 1];
    }
    return null;
  }

  stopMonitoring() {
    this.monitoring = false;
    logger.info('Candle Service stopped');
  }
}

export class IndicatorService {
  constructor() {
    this.cache = new Map();
  }

  calculateSMA(prices, period) {
    if (prices.length < period) return null;
    const sum = prices.slice(-period).reduce((a, b) => a + parseFloat(b), 0);
    return sum / period;
  }

  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + parseFloat(b)) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (parseFloat(prices[i]) - ema) * multiplier + ema;
    }
    return ema;
  }

  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    let gains = 0, losses = 0;

    for (let i = 1; i < period + 1; i++) {
      const change = parseFloat(prices[i]) - parseFloat(prices[i - 1]);
      if (change > 0) gains += change;
      else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
    const fastEMA = this.calculateEMA(prices, fast);
    const slowEMA = this.calculateEMA(prices, slow);
    if (!fastEMA || !slowEMA) return null;
    const macdLine = fastEMA - slowEMA;
    const signalLine = this.calculateEMA([...prices], signal);
    return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
  }

  cacheIndicator(key, value, ttl = config.INDICATOR_CACHE_TTL_MS) {
    this.cache.set(key, { value, expiry: Date.now() + ttl });
  }

  getCachedIndicator(key) {
    const item = this.cache.get(key);
    if (item && item.expiry > Date.now()) return item.value;
    this.cache.delete(key);
    return null;
  }
}

export class HealthCheckService {
  constructor(config, exchangeAPI, wsManager) {
    this.config = config;
    this.exchangeAPI = exchangeAPI;
    this.wsManager = wsManager;
    this.isHealthy = true;
    this.lastCheck = Date.now();
  }

  async check() {
    try {
      const serverTime = await this.exchangeAPI.getServerTime();
      const isWsConnected = this.wsManager.isConnected();
      const timeDiff = Math.abs(Date.now() - serverTime.serverTime);

      this.isHealthy = timeDiff < config.HEALTH_DATA_MAX_AGE_MS && isWsConnected;
      this.lastCheck = Date.now();
      return { healthy: this.isHealthy, timeDiff, wsConnected: isWsConnected };
    } catch (err) {
      this.isHealthy = false;
      Logger.getInstance().error('Health check failed:', err);
      return { healthy: false, error: err.message };
    }
  }

  startHeartbeat(interval = config.HEARTBEAT_INTERVAL_MS) {
    setInterval(() => this.check(), interval);
  }

  getStatus() {
    return {
      healthy: this.isHealthy,
      lastCheck: this.lastCheck,
      uptime: process.uptime(),
    };
  }
}
