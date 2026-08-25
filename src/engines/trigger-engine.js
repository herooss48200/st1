import logger from '../services/logger.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';

class TriggerEngine {
  constructor() {
    this.period = TRADING_CONSTANTS.TRIGGER_BOLLINGER_PERIOD;
    this.stdDev = TRADING_CONSTANTS.BOLLINGER_STD_DEV;
    this.source = TRADING_CONSTANTS.BOLLINGER_SOURCE;
  }

  async detectTrigger(candle) {
    try {
      // Mock trigger detection - 30% probability
      const trigger = Math.random() > 0.7;
      if (!trigger) {
        return { signal: 'NONE', price: candle.close };
      }

      const signal = Math.random() > 0.5 ? 'BUY' : 'SELL';
      logger.info('🔔 Trigger Detected', {
        signal,
        price: candle.close.toFixed(8)
      });

      return { signal, price: candle.close };
    } catch (error) {
      logger.error('Trigger detection failed', error);
      return { signal: 'NONE', price: candle.close };
    }
  }

  async analyzeTrigger(candles) {
    try {
      if (!candles || candles.length < this.period) {
        return { triggered: false, type: null };
      }

      const bb = this.calculateBollingerBands(candles);
      const lastCandle = candles[candles.length - 1];
      const price = this.getSourcePrice(lastCandle);

      let triggered = false;
      let triggerType = null;

      if (price <= bb.lower) {
        triggered = true;
        triggerType = 'LOWER_BAND';
      } else if (price >= bb.upper) {
        triggered = true;
        triggerType = 'UPPER_BAND';
      }

      if (triggered) {
        logger.info('Trigger detected', {
          type: triggerType,
          price: price.toFixed(8),
          middle: bb.middle.toFixed(8),
          upper: bb.upper.toFixed(8),
          lower: bb.lower.toFixed(8)
        });
      }

      return {
        triggered,
        type: triggerType,
        price,
        bb
      };
    } catch (error) {
      logger.error('Trigger analysis failed', error);
      throw error;
    }
  }

  analyzeSt1BollingerSetup(candles, signal, options = {}) {
    const atrPeriod = Number(options.atrPeriod || TRADING_CONSTANTS.ATR_PERIOD || 14);
    const touchAtrMultiplier = Number(options.touchAtrMultiplier ?? 0.10);
    const requiredCandles = Math.max(this.period, atrPeriod + 1);

    if (!Array.isArray(candles) || candles.length < requiredCandles || !['BUY', 'SELL'].includes(signal)) {
      return { triggered: false, type: null, reason: 'ST1_SETUP_DATA_INSUFFICIENT' };
    }

    const setup = candles.at(-1);
    const open = Number(setup?.open);
    const high = Number(setup?.high);
    const low = Number(setup?.low);
    const close = Number(setup?.close);
    if (![open, high, low, close].every(Number.isFinite)) {
      return { triggered: false, type: null, reason: 'ST1_SETUP_CANDLE_INVALID' };
    }

    const bb = this.calculateBollingerBands(candles);
    const atr = this.calculateATR(candles, atrPeriod);
    if (![bb?.lower, bb?.upper, atr].every(Number.isFinite)) {
      return { triggered: false, type: null, reason: 'ST1_SETUP_INDICATOR_INVALID' };
    }

    const tolerance = Math.max(0, atr * touchAtrMultiplier);
    const isRed = close < open;
    const isGreen = close > open;
    const distanceToBand = signal === 'BUY'
      ? Math.max(0, low - bb.lower)
      : Math.max(0, bb.upper - high);
    const bandTouchedOrApproached = distanceToBand <= tolerance;
    const colorAligned = signal === 'BUY' ? isRed : isGreen;
    const triggered = colorAligned && bandTouchedOrApproached;

    return {
      triggered,
      type: triggered ? (signal === 'BUY' ? 'ST1_LOWER_BB_RED_SETUP' : 'ST1_UPPER_BB_GREEN_SETUP') : null,
      reason: triggered ? 'ST1_BOLLINGER_SETUP_CONFIRMED' : 'ST1_BOLLINGER_SETUP_NOT_READY',
      signal,
      bb,
      atr,
      tolerance,
      distanceToBand,
      bandTouchedOrApproached,
      colorAligned,
      setupOpen: open,
      setupHigh: high,
      setupLow: low,
      setupClose: close,
      bodyBreakPrice: signal === 'BUY' ? Math.max(open, close) : Math.min(open, close)
    };
  }

  isSt1ConfirmationCandle(candle, signal) {
    const open = Number(candle?.open);
    const close = Number(candle?.close);
    if (![open, close].every(Number.isFinite) || !['BUY', 'SELL'].includes(signal)) {
      return false;
    }
    return signal === 'BUY' ? close > open : close < open;
  }

  analyzeEmaTouch(candles, signal, options = {}) {
    const emaPeriod = Number(options.emaPeriod || TRADING_CONSTANTS.FULL_ALIGNMENT_EMA_PERIOD);
    const atrPeriod = Number(options.atrPeriod || TRADING_CONSTANTS.ATR_PERIOD || 14);
    const touchAtrMultiplier = Number(
      options.touchAtrMultiplier ?? TRADING_CONSTANTS.FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER
    );
    const requireReclaim = options.requireReclaim
      ?? TRADING_CONSTANTS.FULL_ALIGNMENT_EMA_REQUIRE_RECLAIM;
    const requireSlope = options.requireSlope
      ?? TRADING_CONSTANTS.FULL_ALIGNMENT_EMA_REQUIRE_SLOPE;
    const requiredCandles = Math.max(emaPeriod + 1, atrPeriod + 1);

    if (!Array.isArray(candles) || candles.length < requiredCandles || !['BUY', 'SELL'].includes(signal)) {
      return { triggered: false, type: null, reason: 'EMA_DATA_INSUFFICIENT' };
    }

    const last = candles.at(-1);
    const previous = candles.at(-2);
    const ema = this.calculateEMA(candles, emaPeriod);
    const previousEma = this.calculateEMA(candles.slice(0, -1), emaPeriod);
    const atr = this.calculateATR(candles, atrPeriod);
    if (![ema, previousEma, atr].every(Number.isFinite)) {
      return { triggered: false, type: null, reason: 'EMA_DATA_INVALID' };
    }

    const tolerance = Math.max(0, atr * touchAtrMultiplier);
    const low = Number(last.low);
    const high = Number(last.high);
    const close = Number(last.close);
    const previousClose = Number(previous.close);
    const candleDistanceToEma = ema < low
      ? low - ema
      : ema > high
        ? ema - high
        : 0;
    const touched = Number.isFinite(candleDistanceToEma) && candleDistanceToEma <= tolerance;
    const approachedFromCorrectSide = signal === 'BUY'
      ? previousClose > previousEma
      : previousClose < previousEma;
    const reclaimed = signal === 'BUY' ? close >= ema : close <= ema;
    const slopeAligned = signal === 'BUY' ? ema > previousEma : ema < previousEma;
    const triggered = touched
      && approachedFromCorrectSide
      && (!requireReclaim || reclaimed)
      && (!requireSlope || slopeAligned);
    const type = triggered ? `EMA${emaPeriod}_TOUCH_RECLAIM` : null;

    return {
      triggered,
      type,
      signal,
      ema,
      previousEma,
      atr,
      tolerance,
      touched,
      approachedFromCorrectSide,
      reclaimed,
      slopeAligned,
      price: close
    };
  }

  calculateEMA(candles, period) {
    const closes = Array.isArray(candles)
      ? candles.map(candle => Number(candle?.close)).filter(Number.isFinite)
      : [];
    if (closes.length < period || period < 2) return null;
    const multiplier = 2 / (period + 1);
    let ema = closes[0];
    for (let index = 1; index < closes.length; index += 1) {
      ema = ((closes[index] - ema) * multiplier) + ema;
    }
    return ema;
  }

  calculateATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return null;
    const trueRanges = [];
    for (let index = 1; index < candles.length; index += 1) {
      const high = Number(candles[index]?.high);
      const low = Number(candles[index]?.low);
      const previousClose = Number(candles[index - 1]?.close);
      if (![high, low, previousClose].every(Number.isFinite)) return null;
      trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
    }
    const window = trueRanges.slice(-period);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  }

  calculateBollingerBands(candles) {
    const prices = candles.slice(-this.period).map(c => 
      this.getSourcePrice(c)
    );

    const sma = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => 
      sum + Math.pow(p - sma, 2), 0
    ) / prices.length;
    const std = Math.sqrt(variance);

    return {
      middle: sma,
      upper: sma + (this.stdDev * std),
      lower: sma - (this.stdDev * std)
    };
  }

  getSourcePrice(candle) {
    switch (this.source.toLowerCase()) {
      case 'open': return candle.open;
      case 'high': return candle.high;
      case 'low': return candle.low;
      case 'close': return candle.close;
      case 'hl2': return (candle.high + candle.low) / 2;
      case 'ohlc4': return (candle.open + candle.high + candle.low + candle.close) / 4;
      default: return candle.close;
    }
  }
}

export { TriggerEngine };
export default new TriggerEngine();
