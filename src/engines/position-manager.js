import logger from '../services/logger.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';

class PositionManager {
  constructor() {
    this.atrPeriod = TRADING_CONSTANTS.ATR_PERIOD;
    this.atrMultiplierSL = TRADING_CONSTANTS.ATR_MULTIPLIER_SL;
    this.atrMultiplierTS = TRADING_CONSTANTS.ATR_MULTIPLIER_TRAILING;
    this.beActivationPercent = TRADING_CONSTANTS.BE_ACTIVATION_PERCENT;
  }

  async updatePosition(position, candles) {
    try {
      const atr = this.calculateATR(candles);
      const currentPrice = candles[candles.length - 1].close;

      // Calculate levels
      let tp = this.calculateTakeProfit(position);
      let sl = this.calculateStopLoss(position, atr);
      let be = null;
      let ts = null;

      // Check Break Even trigger
      const profitPercent = (currentPrice - position.entryPrice) / position.entryPrice;
      if (profitPercent >= this.beActivationPercent) {
        be = position.entryPrice + (position.entryPrice * 0.0005);
      }

      // Trailing Stop
      if (position.direction === 'LONG') {
        const trailingPrice = currentPrice - (atr * this.atrMultiplierTS);
        ts = Math.max(position.trailingStop || position.stopLoss || 0, trailingPrice);
      } else {
        const trailingPrice = currentPrice + (atr * this.atrMultiplierTS);
        ts = Math.min(position.trailingStop || position.stopLoss || Infinity, trailingPrice);
      }

      logger.info('Position updated', {
        positionId: position.id,
        currentPrice: currentPrice.toFixed(8),
        tp: tp.toFixed(8),
        sl: sl.toFixed(8),
        be: be ? be.toFixed(8) : 'N/A',
        ts: ts ? ts.toFixed(8) : 'N/A'
      });

      return {
        takeProfit: tp,
        stopLoss: sl,
        breakEven: be,
        trailingStop: ts,
        atr
      };
    } catch (error) {
      logger.error('Position update failed', error);
      throw error;
    }
  }

  calculateTakeProfit(position) {
    const tpPercent = 2.5 / 100;
    if (position.direction === 'LONG') {
      return position.entryPrice * (1 + tpPercent);
    } else {
      return position.entryPrice * (1 - tpPercent);
    }
  }

  calculateStopLoss(position, atr) {
    const slDistance = atr * this.atrMultiplierSL;
    if (position.direction === 'LONG') {
      return position.entryPrice - slDistance;
    } else {
      return position.entryPrice + slDistance;
    }
  }

  calculateATR(candles) {
    if (candles.length < this.atrPeriod) {
      return this.calculateTR(candles[candles.length - 1]) || 0;
    }

    let trSum = 0;
    for (let i = candles.length - this.atrPeriod; i < candles.length; i++) {
      trSum += this.calculateTR(candles[i], candles[i - 1]);
    }
    return trSum / this.atrPeriod;
  }

  calculateTR(candle, prevCandle) {
    if (!candle) return 0;
    
    const high = candle.high;
    const low = candle.low;
    const prevClose = prevCandle ? prevCandle.close : candle.open;

    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);

    return Math.max(tr1, tr2, tr3);
  }

  checkExitSignal(position, currentPrice) {
    if (position.direction === 'LONG') {
      if (currentPrice >= position.takeProfit) return { exit: true, reason: 'TP' };
      if (currentPrice <= position.stopLoss) return { exit: true, reason: 'SL' };
      if (currentPrice <= position.trailingStop) return { exit: true, reason: 'TS' };
    } else {
      if (currentPrice <= position.takeProfit) return { exit: true, reason: 'TP' };
      if (currentPrice >= position.stopLoss) return { exit: true, reason: 'SL' };
      if (currentPrice >= position.trailingStop) return { exit: true, reason: 'TS' };
    }
    return { exit: false, reason: null };
  }
}

export { PositionManager };
export default new PositionManager();
