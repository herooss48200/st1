import logger from '../services/logger.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';
import config from '../config/config.js';

const EPSILON = 1e-12;

class SimilarityEngine {
  constructor() {
    this.window = parseInt(process.env.SIMILARITY_WINDOW_SIZE || process.env.SIMILARITY_WINDOW || TRADING_CONSTANTS.SIMILARITY_WINDOW_SIZE, 10);
    this.threshold = parseFloat(process.env.SIMILARITY_THRESHOLD || String(TRADING_CONSTANTS.SIMILARITY_THRESHOLD * 100)) / 100;
    this.weights = TRADING_CONSTANTS.SIMILARITY_WEIGHTS;
    this.btcWeight = config.SIMILARITY_BTC_WEIGHT / 100;
    this.ethWeight = config.SIMILARITY_ETH_WEIGHT / 100;
  }

  async analyzeSimilarity(coinCandles, btcCandles, ethCandles = null) {
    try {
      const btc = this.alignCandlesByTimestamp(coinCandles, btcCandles);
      if (!this.validateCandles(btc.coin, btc.reference)) {
        return { score: 0, valid: false, reason: btc.reason || 'BTC_CANDLES_INVALID' };
      }
      const btcScores = this.calculateScores(btc.coin, btc.reference);
      const btcSimilarity = this.weightScores(btcScores);
      let finalScore = btcSimilarity;
      let ethSimilarity = null;
      let ethScores = null;

      if (Array.isArray(ethCandles)) {
        const eth = this.alignCandlesByTimestamp(coinCandles, ethCandles);
        if (!this.validateCandles(eth.coin, eth.reference)) {
          return { score: 0, valid: false, reason: eth.reason || 'ETH_CANDLES_INVALID' };
        }
        ethScores = this.calculateScores(eth.coin, eth.reference);
        ethSimilarity = this.weightScores(ethScores);
        finalScore = this.combineSimilarityScores(btcSimilarity, ethSimilarity);
      }

      logger.info('Similarity analysis', { coin: btc.coin[0]?.symbol, score: finalScore, qualified: finalScore >= this.threshold, alignedCandles: btc.coin.length });
      return {
        score: finalScore, finalSimilarity: finalScore, valid: true,
        qualified: finalScore >= this.threshold, threshold: this.threshold,
        scores: btcScores, btcScores, ethScores, btcSimilarity, ethSimilarity
      };
    } catch (error) {
      logger.error('Similarity analysis failed', { error: error.message, stackTrace: error.stack || null });
      return { score: 0, valid: false, reason: 'SIMILARITY_CALCULATION_FAILED', error: error.message };
    }
  }

  calculateScores(coin, reference) {
    return {
      pearson: this.calculatePearsonScore(coin, reference),
      body: this.calculateBodyScore(coin, reference),
      wickUpper: this.calculateWickUpperScore(coin, reference),
      wickLower: this.calculateWickLowerScore(coin, reference),
      range: this.calculateRangeScore(coin, reference),
      volume: this.calculateVolumeScore(coin, reference),
      momentum: this.calculateMomentumScore(coin, reference),
      trend: this.calculateTrendScore(coin, reference),
      pattern: this.calculatePatternScore(coin, reference)
    };
  }

  getTimestamp(candle) {
    const timestamp = Number(candle?.openTime ?? candle?.timestamp ?? candle?.time ?? candle?.closeTime);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  alignCandlesByTimestamp(coinCandles, referenceCandles) {
    if (!Array.isArray(coinCandles) || !Array.isArray(referenceCandles)) return { coin: [], reference: [], reason: 'CANDLES_NOT_ARRAYS' };
    const byTime = new Map(referenceCandles.map((candle) => [this.getTimestamp(candle), candle]).filter(([time]) => time !== null));
    const pairs = coinCandles
      .map((candle) => [candle, byTime.get(this.getTimestamp(candle))])
      .filter(([, reference]) => reference)
      .sort((a, b) => this.getTimestamp(a[0]) - this.getTimestamp(b[0]))
      .slice(-this.window);
    return {
      coin: pairs.map(([candle]) => candle),
      reference: pairs.map(([, reference]) => reference),
      reason: pairs.length === 0 ? 'NO_TIMESTAMP_OVERLAP' : null
    };
  }

  averageSimilarity(coin, reference, extractor) {
    return coin.reduce((sum, candle, i) => sum + Math.max(0, 1 - Math.abs(extractor(candle) - extractor(reference[i]))), 0) / coin.length;
  }

  calculateBodyScore(coin, reference) {
    return this.averageSimilarity(coin, reference, (candle) => this.getSignedBodyPercent(candle));
  }

  calculateWickUpperScore(coin, reference) {
    return this.averageSimilarity(coin, reference, (candle) => this.getUpperWickPercent(candle));
  }

  calculateWickLowerScore(coin, reference) {
    return this.averageSimilarity(coin, reference, (candle) => this.getLowerWickPercent(candle));
  }

  calculateRangeScore(coin, reference) {
    return coin.reduce((sum, candle, i) => {
      const a = Math.abs((Number(candle.high) - Number(candle.low)) / Number(candle.close));
      const b = Math.abs((Number(reference[i].high) - Number(reference[i].low)) / Number(reference[i].close));
      return sum + Math.max(0, 1 - Math.abs(a - b) / Math.max(a, b, EPSILON));
    }, 0) / coin.length;
  }

  calculateVolumeScore(coin, reference) {
    const lookback = Math.min(10, Math.max(1, coin.length - 1));
    let total = 0;
    let samples = 0;
    for (let i = lookback; i < coin.length; i++) {
      const avg = (candles) => candles.slice(i - lookback, i).reduce((sum, candle) => sum + Number(candle.volume || 0), 0) / lookback;
      const coinAvg = avg(coin);
      const referenceAvg = avg(reference);
      if (coinAvg <= 0 || referenceAvg <= 0) continue;
      const a = (Number(coin[i].volume || 0) - coinAvg) / coinAvg;
      const b = (Number(reference[i].volume || 0) - referenceAvg) / referenceAvg;
      total += Math.max(0, 1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), EPSILON));
      samples += 1;
    }
    return samples ? total / samples : 0;
  }

  getReturns(candles) {
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      const previous = Number(candles[i - 1].close);
      const current = Number(candles[i].close);
      if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
    }
    return returns;
  }

  calculatePearsonScore(coin, reference) {
    const a = this.getReturns(coin);
    const b = this.getReturns(reference);
    const length = Math.min(a.length, b.length);
    if (length < 2) return 0;
    const meanA = a.reduce((sum, value) => sum + value, 0) / length;
    const meanB = b.reduce((sum, value) => sum + value, 0) / length;
    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;
    for (let i = 0; i < length; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      covariance += da * db;
      varianceA += da ** 2;
      varianceB += db ** 2;
    }
    const denominator = Math.sqrt(varianceA * varianceB);
    if (denominator <= EPSILON) return varianceA <= EPSILON && varianceB <= EPSILON ? 1 : 0;
    return Math.max(0, Math.min(1, (covariance / denominator + 1) / 2));
  }

  calculateMomentumScore(coin, reference) {
    const a = this.getReturns(coin).reduce((sum, value) => sum + value, 0);
    const b = this.getReturns(reference).reduce((sum, value) => sum + value, 0);
    if (Math.abs(a) <= EPSILON && Math.abs(b) <= EPSILON) return 1;
    if (Math.sign(a) !== Math.sign(b)) return 0;
    return Math.max(0, 1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), EPSILON));
  }

  normalizedRegressionSlope(candles) {
    const first = Number(candles[0]?.close);
    if (!(first > 0) || candles.length < 2) return 0;
    const values = candles.map((candle) => Number(candle.close) / first - 1);
    const xMean = (values.length - 1) / 2;
    const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0;
    let denominator = 0;
    values.forEach((value, i) => {
      numerator += (i - xMean) * (value - yMean);
      denominator += (i - xMean) ** 2;
    });
    return denominator <= EPSILON ? 0 : numerator / denominator;
  }

  calculateTrendScore(coin, reference) {
    const a = this.normalizedRegressionSlope(coin);
    const b = this.normalizedRegressionSlope(reference);
    if (Math.abs(a) <= EPSILON && Math.abs(b) <= EPSILON) return 1;
    if (Math.sign(a) !== Math.sign(b)) return 0;
    return Math.max(0, 1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), EPSILON));
  }

  classifyCandle(candle, previous = null) {
    const body = this.getSignedBodyPercent(candle);
    const upper = this.getUpperWickPercent(candle);
    const lower = this.getLowerWickPercent(candle);
    if (Math.abs(body) <= 0.1) return 'DOJI';
    if (lower >= Math.abs(body) * 2 && upper <= Math.abs(body)) return body > 0 ? 'BULL_HAMMER' : 'BEAR_HAMMER';
    if (upper >= Math.abs(body) * 2 && lower <= Math.abs(body)) return body > 0 ? 'BULL_SHOOTING' : 'BEAR_SHOOTING';
    if (previous) {
      const currentLow = Math.min(Number(candle.open), Number(candle.close));
      const currentHigh = Math.max(Number(candle.open), Number(candle.close));
      const previousLow = Math.min(Number(previous.open), Number(previous.close));
      const previousHigh = Math.max(Number(previous.open), Number(previous.close));
      if (Math.sign(body) !== Math.sign(this.getSignedBodyPercent(previous)) && currentLow <= previousLow && currentHigh >= previousHigh) {
        return body > 0 ? 'BULL_ENGULFING' : 'BEAR_ENGULFING';
      }
    }
    return body > 0 ? 'BULL' : 'BEAR';
  }

  calculatePatternScore(coin, reference) {
    return coin.reduce((matches, candle, i) => matches + (
      this.classifyCandle(candle, coin[i - 1]) === this.classifyCandle(reference[i], reference[i - 1]) ? 1 : 0
    ), 0) / coin.length;
  }

  weightScores(scores) {
    const weighted = scores.pearson * this.weights.pearson +
      scores.body * this.weights.body +
      scores.wickUpper * this.weights.wick_upper +
      scores.wickLower * this.weights.wick_lower +
      scores.range * this.weights.range +
      scores.volume * this.weights.volume +
      scores.momentum * this.weights.momentum +
      scores.trend * this.weights.trend +
      scores.pattern * this.weights.pattern;
    const total = Object.values(this.weights).reduce((sum, weight) => sum + weight, 0);
    return total > 0 ? Math.max(0, Math.min(1, weighted / total)) : 0;
  }

  combineSimilarityScores(btc, eth) {
    btc = Number(btc);
    eth = Number(eth);
    return Number.isFinite(btc) && Number.isFinite(eth) ? Math.max(0, Math.min(1, btc * this.btcWeight + eth * this.ethWeight)) : 0;
  }

  getSignedBodyPercent(candle) {
    const range = Number(candle.high) - Number(candle.low);
    return range > 0 ? (Number(candle.close) - Number(candle.open)) / range : 0;
  }

  getBodyPercent(candle) {
    return Math.abs(this.getSignedBodyPercent(candle));
  }

  getUpperWickPercent(candle) {
    const range = Number(candle.high) - Number(candle.low);
    return range > 0 ? (Number(candle.high) - Math.max(Number(candle.open), Number(candle.close))) / range : 0;
  }

  getLowerWickPercent(candle) {
    const range = Number(candle.high) - Number(candle.low);
    return range > 0 ? (Math.min(Number(candle.open), Number(candle.close)) - Number(candle.low)) / range : 0;
  }

  validateCandles(coin, reference) {
    if (!Array.isArray(coin) || !Array.isArray(reference) || coin.length < 2 || coin.length !== reference.length) return false;
    return coin.every((candle, i) => {
      const values = [candle.open, candle.high, candle.low, candle.close, reference[i].open, reference[i].high, reference[i].low, reference[i].close].map(Number);
      return this.getTimestamp(candle) !== null && this.getTimestamp(candle) === this.getTimestamp(reference[i]) && values.every(Number.isFinite);
    });
  }
}

export { SimilarityEngine };
export default new SimilarityEngine();
