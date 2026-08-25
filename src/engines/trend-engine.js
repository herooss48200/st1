import logger from '../services/logger.js';
import { config } from '../config/index.js';
import { TREND_TYPE } from '../shared/types/index.js';

class TrendEngine {
  constructor() {
    this.emaFastPeriod = config.BTC_TREND_EMA_FAST_PERIOD;
    this.emaSlowPeriod = config.BTC_TREND_EMA_SLOW_PERIOD;
    this.sidewaysThresholdPercent = config.BTC_TREND_EMA_SIDEWAYS_THRESHOLD_PERCENT;
  }

  async analyzeTrend(btcCandles, ethCandles = null) {
    try {
      const now = Date.now();
      const validCandles = Array.isArray(btcCandles)
        ? btcCandles.filter((candle) => {
            const close = Number(candle?.close);
            if (!Number.isFinite(close) || close <= 0) return false;
            const closeTime = Number(candle?.closeTime ?? candle?.close_time ?? candle?.closeTimestamp);
            return !Number.isFinite(closeTime) || closeTime <= now;
          })
        : [];
      if (validCandles.length < this.emaSlowPeriod) {
        logger.warning('Insufficient valid BTC candles for trend analysis', {
          required: this.emaSlowPeriod,
          received: validCandles.length
        });
        return { trend: TREND_TYPE.SIDEWAYS, confidence: 0 };
      }

      const ema50 = this.calculateEMA(validCandles, this.emaFastPeriod);
      const ema200 = this.calculateEMA(validCandles, this.emaSlowPeriod);
      const currentPrice = Number(validCandles[validCandles.length - 1].close);
      const previousPrice = Number(validCandles[validCandles.length - 2].close);
      const priceChange = (currentPrice - previousPrice) / previousPrice;
      const emaGapPercent = ema200 === 0 ? 0 : Math.abs((ema50 - ema200) / ema200) * 100;
      const adx = this.calculateADX(validCandles);

      // The market regime itself is always LONG/SHORT when EMAs are ordered.
      // When the two EMAs enter the transition corridor, direction is remembered
      // but new entries are locked until the gap opens again.
      let trend = TREND_TYPE.SIDEWAYS;
      if (ema50 > ema200) trend = TREND_TYPE.UP;
      else if (ema50 < ema200) trend = TREND_TYPE.DOWN;

      const transitionLocked = emaGapPercent <= this.sidewaysThresholdPercent || trend === TREND_TYPE.SIDEWAYS;
      const confidence = transitionLocked ? 0.5 : Math.min(1, emaGapPercent / 2);

      logger.info('BTC trend analyzed', {
        trend,
        confidence,
        priceChange: (priceChange * 100).toFixed(2) + '%',
        currentPrice,
        ema50: ema50.toFixed(2),
        ema200: ema200.toFixed(2),
        emaGapPercent: emaGapPercent.toFixed(4) + '%',
        adx: adx !== null ? adx.toFixed(2) : 'N/A',
        transitionLocked
      });

      const result = { trend, confidence, priceChange, ema50, ema200, emaGapPercent, adx, transitionLocked };
      if (!ethCandles) {
        return result;
      }

      const ethResult = await this.analyzeTrend(ethCandles);
      return {
        ...result,
        btcTrend: trend,
        ethTrend: ethResult.trend,
        btcTransitionLocked: transitionLocked,
        ethTransitionLocked: ethResult.transitionLocked === true
      };
    } catch (error) {
      logger.error('Trend analysis failed', error);
      throw error;
    }
  }

  calculateEMA(candles, period) {
    if (!Array.isArray(candles) || candles.length < period) return 0;

    const closes = candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
    if (closes.length < period) return 0;

    // Stable warm-up: seed with the first full-period SMA, then run the EMA
    // across every remaining closed candle. With BTC_TREND_CANDLE_LIMIT=1000
    // this removes the former 201-candle cold-start distortion.
    const multiplier = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((sum, close) => sum + close, 0) / period;

    for (let i = period; i < closes.length; i += 1) {
      ema = ((closes[i] - ema) * multiplier) + ema;
    }

    return ema;
  }

  calculateADX(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;

    const trueRanges = [];
    const plusDMs = [];
    const minusDMs = [];

    for (let i = 1; i < candles.length; i++) {
      const high = Number(candles[i].high);
      const low = Number(candles[i].low);
      const prevHigh = Number(candles[i - 1].high);
      const prevLow = Number(candles[i - 1].low);
      const prevClose = Number(candles[i - 1].close);

      const upMove = high - prevHigh;
      const downMove = prevLow - low;

      const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );

      trueRanges.push(tr);
      plusDMs.push(plusDM);
      minusDMs.push(minusDM);
    }

    if (trueRanges.length < period) return null;

    let smoothedTR = 0;
    let smoothedPlusDM = 0;
    let smoothedMinusDM = 0;

    for (let i = 0; i < period; i++) {
      smoothedTR += trueRanges[i];
      smoothedPlusDM += plusDMs[i];
      smoothedMinusDM += minusDMs[i];
    }

    const dxValues = [];
    const initialPlusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
    const initialMinusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
    const initialSumDI = initialPlusDI + initialMinusDI;
    dxValues.push(initialSumDI === 0 ? 0 : (Math.abs(initialPlusDI - initialMinusDI) / initialSumDI) * 100);

    for (let i = period; i < trueRanges.length; i++) {
      smoothedTR = smoothedTR - (smoothedTR / period) + trueRanges[i];
      smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDMs[i];
      smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDMs[i];

      const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
      const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
      const sumDI = plusDI + minusDI;
      const dx = sumDI === 0 ? 0 : (Math.abs(plusDI - minusDI) / sumDI) * 100;

      dxValues.push(dx);
    }

    if (dxValues.length < period) return null;

    let adx = 0;
    for (let i = 0; i < period; i++) {
      adx += dxValues[i];
    }
    adx /= period;

    for (let i = period; i < dxValues.length; i++) {
      adx = ((adx * (period - 1)) + dxValues[i]) / period;
    }

    return adx;
  }
}

export { TrendEngine };
export default new TrendEngine();
