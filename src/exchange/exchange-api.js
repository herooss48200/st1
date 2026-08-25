import axios from 'axios';
import { Logger } from '../services/logger.js';
import { ErrorManager } from '../core/error-manager.js';
import config from '../config/config.js';

const logger = Logger.getInstance();
const errorManager = ErrorManager.getInstance();

const RATE_LIMITS = {
  REQUESTS_PER_MINUTE: config.API_REQUESTS_PER_WINDOW,
  WEIGHT_PER_MINUTE: config.API_WEIGHT_PER_WINDOW,
};

export class ExchangeAPI {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.getExchangeUrl();
    this.apiKey = config.get('EXCHANGE_API_KEY');
    this.apiSecret = config.get('EXCHANGE_API_SECRET');
    this.requestCount = 0;
    this.lastResetTime = Date.now();
  }

  async checkRateLimit(weight = 1) {
    const now = Date.now();
    if (now - this.lastResetTime > config.API_RATE_LIMIT_WINDOW) {
      this.requestCount = 0;
      this.lastResetTime = now;
    }
    if (this.requestCount + weight > RATE_LIMITS.REQUESTS_PER_MINUTE) {
      const waitTime = config.API_RATE_LIMIT_WINDOW - (now - this.lastResetTime);
      await new Promise(r => setTimeout(r, waitTime));
      this.requestCount = 0;
      this.lastResetTime = Date.now();
    }
    this.requestCount += weight;
  }

  async request(method, endpoint, params = {}) {
    try {
      await this.checkRateLimit();
      const headers = { 'X-MBX-APIKEY': this.apiKey };
      const response = await axios({
        method,
        url: `${this.baseUrl}${endpoint}`,
        params,
        headers,
        timeout: config.EXCHANGE_API_REQUEST_TIMEOUT_MS
      });
      return response.data;
    } catch (err) {
      errorManager.handleError(err, 'EXCHANGE');
      throw err;
    }
  }

  async getServerTime() {
    return this.request('GET', '/api/v3/time');
  }

  async getExchangeInfo() {
    return this.request('GET', '/api/v3/exchangeInfo');
  }

  async getSymbolPrice(symbol) {
    return this.request('GET', '/api/v3/ticker/price', { symbol });
  }

  async get24hrStats(symbol) {
    return this.request('GET', '/api/v3/ticker/24hr', { symbol });
  }

  async getKlines(symbol, interval, limit = 500) {
    const params = { symbol, interval, limit };
    return this.request('GET', '/api/v3/klines', params);
  }

  async getOrderBook(symbol, limit = config.ORDER_BOOK_DEFAULT_LIMIT) {
    return this.request('GET', '/api/v3/depth', { symbol, limit });
  }

  async placeOrder(symbol, side, quantity, price, timeInForce = 'GTC') {
    const params = { symbol, side, type: 'LIMIT', timeInForce, quantity, price, timestamp: Date.now() };
    return this.request('POST', '/api/v3/order', params);
  }

  async cancelOrder(symbol, orderId) {
    const params = { symbol, orderId, timestamp: Date.now() };
    return this.request('DELETE', '/api/v3/order', params);
  }

  async getOpenOrders(symbol = null) {
    const params = { timestamp: Date.now() };
    if (symbol) params.symbol = symbol;
    return this.request('GET', '/api/v3/openOrders', params);
  }

  async getAccountInfo() {
    const params = { timestamp: Date.now() };
    return this.request('GET', '/api/v3/account', params);
  }

  async getBalance(asset) {
    const account = await this.getAccountInfo();
    return account.balances.find(b => b.asset === asset) || { asset, free: '0', locked: '0' };
  }

  async getMyTrades(symbol, limit = 500) {
    const params = { symbol, limit, timestamp: Date.now() };
    return this.request('GET', '/api/v3/myTrades', params);
  }
}
