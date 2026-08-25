import logger from '../services/logger.js';
import eventBus from '../core/event-bus.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';

export class SniperEngine {
  constructor() {
    this.ambushList = new Map();
    this.maxCoins = TRADING_CONSTANTS.SNIPER_MAX_SNIPERS;
    this.timeout = TRADING_CONSTANTS.SNIPER_MAX_WAIT_MINUTES * 60 * 1000;
  }

  addToAmbush(symbol, trigger) {
    if (this.ambushList.size >= this.maxCoins) {
      logger.warn(`Ambush list full (${this.maxCoins} coins max)`);
      return false;
    }
    this.ambushList.set(symbol, {
      trigger,
      addedTime: Date.now(),
      attempts: 0,
    });
    logger.info(`${symbol} added to ambush list`);
    eventBus.emit('sniper-add', { symbol, trigger });
    return true;
  }

  removeFromAmbush(symbol) {
    this.ambushList.delete(symbol);
    logger.info(`${symbol} removed from ambush`);
  }

  checkTimeout() {
    const now = Date.now();
    for (const [symbol, data] of this.ambushList) {
      if (now - data.addedTime > this.timeout) {
        this.removeFromAmbush(symbol);
        logger.info(`${symbol} ambush timeout`);
      }
    }
  }

  getAmbushList() {
    this.checkTimeout();
    return Array.from(this.ambushList.keys());
  }

  recordAttempt(symbol) {
    const data = this.ambushList.get(symbol);
    if (data) {
      data.attempts++;
      logger.debug(`${symbol} attempt ${data.attempts}`);
    }
  }
}

export class PatternEngine {
  constructor() {
    this.patterns = {
      hammer: 'hammer',
      inverted: 'inverted-hammer',
      engulfing: 'engulfing',
      doji: 'doji',
    };
  }

  analyzeCandle(candle) {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const range = candle.high - candle.low;

    if (body / range < 0.1 && upperWick < 0.1 && lowerWick < 0.1) {
      return this.patterns.doji;
    }
    if (lowerWick > body * 2 && upperWick < body * 0.5) {
      return this.patterns.hammer;
    }
    if (upperWick > body * 2 && lowerWick < body * 0.5) {
      return this.patterns.inverted;
    }
    return null;
  }

  analyzeEngulfing(prev, current) {
    if (!prev) return null;
    const currBody = Math.abs(current.close - current.open);
    const prevBody = Math.abs(prev.close - prev.open);

    if (currBody > prevBody * 1.5) {
      if (current.close > Math.max(prev.open, prev.close) &&
          current.open < Math.min(prev.open, prev.close)) {
        return this.patterns.engulfing;
      }
    }
    return null;
  }

  getPatternScore(pattern) {
    const scores = {
      [this.patterns.doji]: 5,
      [this.patterns.hammer]: 8,
      [this.patterns.inverted]: 6,
      [this.patterns.engulfing]: 10,
    };
    return scores[pattern] || 0;
  }
}

export class TradeEngine {
  constructor(orderService, positionManager, eventBus) {
    this.orderService = orderService;
    this.positionManager = positionManager;
    this.eventBus = eventBus;
    this.activePositions = new Map();
  }

  async enterPosition(symbol, signal) {
    try {
      const { quantity, price } = signal;
      const order = await this.orderService.placeOrder({
        symbol,
        side: 'BUY',
        quantity,
        price,
      });

      if (order.status === 'FILLED') {
        const tp = price * (1 + signal.profitPercent / 100);
        const sl = price * (1 - signal.stopPercent / 100);

        const position = {
          symbol,
          quantity,
          entryPrice: price,
          tp,
          sl,
          entryTime: Date.now(),
          orderId: order.orderId,
        };

        this.activePositions.set(symbol, position);
        this.eventBus.emit('position-enter', position);
        logger.info(`Position entered: ${symbol} @ ${price}`);
        return position;
      }
    } catch (err) {
      logger.error(`Entry failed for ${symbol}:`, err);
      this.eventBus.emit('position-error', { symbol, error: err.message });
    }
    return null;
  }

  async exitPosition(symbol, reason) {
    try {
      const pos = this.activePositions.get(symbol);
      if (!pos) return null;

      const order = await this.orderService.placeOrder({
        symbol,
        side: 'SELL',
        quantity: pos.quantity,
        price: pos.tp,
      });

      const exit = {
        symbol,
        exitPrice: order.price,
        exitTime: Date.now(),
        reason,
        profit: (order.price - pos.entryPrice) * pos.quantity,
      };

      this.activePositions.delete(symbol);
      this.eventBus.emit('position-exit', exit);
      logger.info(`Position exited: ${symbol} (${reason})`);
      return exit;
    } catch (err) {
      logger.error(`Exit failed for ${symbol}:`, err);
    }
    return null;
  }

  getActivePositions() {
    return Array.from(this.activePositions.values());
  }
}

export default new SniperEngine();
