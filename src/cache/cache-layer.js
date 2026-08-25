import { Logger } from '../services/logger.js';
import config from '../config/config.js';

const logger = Logger.getInstance();

export class CacheLayer {
  constructor() {
    this.cache = new Map();
  }

  set(key, value, ttl = config.CACHE_TTL) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl,
      created: Date.now(),
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiry < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.cache) {
      if (item.expiry < now) {
        this.cache.delete(key);
      }
    }
  }

  size() {
    return this.cache.size;
  }

  keys() {
    return Array.from(this.cache.keys());
  }
}

export class RecoverySystem {
  constructor(config, exchangeAPI, wsManager, logger) {
    this.config = config;
    this.exchangeAPI = exchangeAPI;
    this.wsManager = wsManager;
    this.logger = logger;
    this.lastState = null;
    this.recoveryAttempts = 0;
    this.maxRecoveryAttempts = 3;
  }

  saveState(state) {
    this.lastState = {
      ...state,
      timestamp: Date.now(),
    };
    this.logger.debug('State saved for recovery');
  }

  async recover() {
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      this.logger.error('Max recovery attempts reached');
      return false;
    }

    this.recoveryAttempts++;
    try {
      this.logger.info(`Recovery attempt ${this.recoveryAttempts}`);

      // Reconnect WebSocket
      if (!this.wsManager.isConnected()) {
        await this.wsManager.connect();
        this.logger.info('WebSocket reconnected');
      }

      // Verify exchange connection
      const serverTime = await this.exchangeAPI.getServerTime();
      this.logger.info('Exchange connection verified');

      // Sync open positions
      const positions = await this.exchangeAPI.getOpenOrders();
      this.logger.info(`Synced ${positions.length} open positions`);

      this.recoveryAttempts = 0;
      return true;
    } catch (err) {
      this.logger.error(`Recovery attempt ${this.recoveryAttempts} failed:`, err);
      return false;
    }
  }

  async autoRecover() {
    const interval = config.CACHE_CLEANUP_INTERVAL_MS;
    setInterval(async () => {
      if (!this.wsManager.isConnected()) {
        await this.recover();
      }
    }, interval);
  }

  resetRecoveryCounter() {
    this.recoveryAttempts = 0;
  }

  getRecoveryStatus() {
    return {
      attempts: this.recoveryAttempts,
      maxAttempts: this.maxRecoveryAttempts,
      lastState: this.lastState,
      timestamp: Date.now(),
    };
  }
}
