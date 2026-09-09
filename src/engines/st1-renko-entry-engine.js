const DEFAULT_OPTIONS = Object.freeze({
  atrPeriod: 14,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  rsiPeriod: 14,
  rsiMaximum: 30,
  rsiMinimum: 70,
  bandToleranceT: 0.25,
  entryOffsetT: 0.25,
  maxBricks: 256
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function calculateAtr(candles, period = DEFAULT_OPTIONS.atrPeriod) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let index = 1; index < candles.length; index += 1) {
    const high = finite(candles[index]?.high);
    const low = finite(candles[index]?.low);
    const previousClose = finite(candles[index - 1]?.close);
    if ([high, low, previousClose].some((value) => value == null)) return null;
    trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }

  const window = trueRanges.slice(-period);
  if (window.length !== period) return null;
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function generateRenkoBricks(candles, boxSize, maxBricks = DEFAULT_OPTIONS.maxBricks) {
  if (!Array.isArray(candles) || candles.length === 0 || !(Number(boxSize) > 0)) return [];

  const limit = Math.max(32, Math.floor(Number(maxBricks) || DEFAULT_OPTIONS.maxBricks));
  const bricks = [];
  let renkoClose = finite(candles[0]?.close);
  let trend = null;
  let totalCount = 0;
  if (renkoClose == null) return [];

  const pushBrick = (open, close, color, candle) => {
    trend = color === 'GREEN' ? 'UP' : 'DOWN';
    renkoClose = close;
    bricks.push({
      id: ++totalCount,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      color,
      closeTime: finite(candle?.closeTime)
    });
    if (bricks.length > limit) bricks.splice(0, bricks.length - limit);
  };

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const price = finite(candle?.close);
    if (price == null) continue;

    let guard = 0;
    while (guard++ < 10000) {
      if (trend === 'UP') {
        if (price >= renkoClose + boxSize) {
          pushBrick(renkoClose, renkoClose + boxSize, 'GREEN', candle);
          continue;
        }
        if (price <= renkoClose - (2 * boxSize)) {
          const previousClose = renkoClose;
          pushBrick(previousClose - boxSize, previousClose - (2 * boxSize), 'RED', candle);
          continue;
        }
        break;
      }

      if (trend === 'DOWN') {
        if (price <= renkoClose - boxSize) {
          pushBrick(renkoClose, renkoClose - boxSize, 'RED', candle);
          continue;
        }
        if (price >= renkoClose + (2 * boxSize)) {
          const previousClose = renkoClose;
          pushBrick(previousClose + boxSize, previousClose + (2 * boxSize), 'GREEN', candle);
          continue;
        }
        break;
      }

      if (price >= renkoClose + boxSize) {
        pushBrick(renkoClose, renkoClose + boxSize, 'GREEN', candle);
        continue;
      }
      if (price <= renkoClose - boxSize) {
        pushBrick(renkoClose, renkoClose - boxSize, 'RED', candle);
        continue;
      }
      break;
    }
  }

  Object.defineProperty(bricks, 'totalCount', {
    value: totalCount,
    enumerable: false
  });
  return bricks;
}

export function calculateBollinger(values, period = DEFAULT_OPTIONS.bollingerPeriod, stdDev = DEFAULT_OPTIONS.bollingerStdDev) {
  if (!Array.isArray(values) || values.length < period) return null;
  const window = values.slice(-period).map(finite);
  if (window.some((value) => value == null)) return null;

  const middle = window.reduce((sum, value) => sum + value, 0) / period;
  const variance = window.reduce((sum, value) => sum + ((value - middle) ** 2), 0) / period;
  const deviation = Math.sqrt(variance);
  return {
    middle,
    upper: middle + (stdDev * deviation),
    lower: middle - (stdDev * deviation)
  };
}

export function calculateRsi(values, period = DEFAULT_OPTIONS.rsiPeriod) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  const prices = values.map(finite);
  if (prices.some((value) => value == null)) return null;

  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = prices[index] - prices[index - 1];
    averageGain += Math.max(0, change);
    averageLoss += Math.max(0, -change);
  }
  averageGain /= period;
  averageLoss /= period;

  for (let index = period + 1; index < prices.length; index += 1) {
    const change = prices[index] - prices[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(0, change)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(0, -change)) / period;
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

export function analyzeSetupFromBricks(bricks, boxSize, signal, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const requiredBricks = Math.max(settings.bollingerPeriod, settings.rsiPeriod + 1);
  if (!Array.isArray(bricks) || bricks.length < requiredBricks || !(Number(boxSize) > 0) || !['BUY', 'SELL'].includes(signal)) {
    return { triggered: false, reason: 'ST1_RENKO_DATA_INSUFFICIENT' };
  }

  const lastBrick = bricks.at(-1);
  const closes = bricks.map((brick) => finite(brick?.close));
  const bollinger = calculateBollinger(closes, settings.bollingerPeriod, settings.bollingerStdDev);
  const rsi = calculateRsi(closes, settings.rsiPeriod);
  const open = finite(lastBrick?.open);
  const high = finite(lastBrick?.high);
  const low = finite(lastBrick?.low);
  const close = finite(lastBrick?.close);
  if (!bollinger || rsi == null || [open, high, low, close].some((value) => value == null)) {
    return { triggered: false, reason: 'ST1_RENKO_INDICATOR_INVALID' };
  }

  const isRed = lastBrick?.color === 'RED' && close < open;
  const isGreen = lastBrick?.color === 'GREEN' && close > open;
  const rsiBelowMaximum = rsi < Number(settings.rsiMaximum);
  const rsiAboveMinimum = rsi > Number(settings.rsiMinimum);
  const tolerancePrice = Math.max(0, Number(settings.bandToleranceT)) * Number(boxSize);
  const distanceToLowerBand = Math.max(0, low - bollinger.lower);
  const distanceToUpperBand = Math.max(0, bollinger.upper - high);
  const lowerBandTouchedApproachedOrCrossed = distanceToLowerBand <= tolerancePrice;
  const upperBandTouchedApproachedOrCrossed = distanceToUpperBand <= tolerancePrice;
  const isBuy = signal === 'BUY';
  const colorAligned = isBuy ? isRed : isGreen;
  const rsiAligned = isBuy ? rsiBelowMaximum : rsiAboveMinimum;
  const bandAligned = isBuy ? lowerBandTouchedApproachedOrCrossed : upperBandTouchedApproachedOrCrossed;
  const triggered = colorAligned && rsiAligned && bandAligned;
  const targetPrice = isBuy
    ? high + (Number(settings.entryOffsetT) * Number(boxSize))
    : low - (Number(settings.entryOffsetT) * Number(boxSize));

  return {
    triggered,
    reason: triggered
      ? (isBuy ? 'ST1_RENKO_RED_RSI30_LOWER_BB_READY' : 'ST1_RENKO_GREEN_RSI70_UPPER_BB_READY')
      : !colorAligned
        ? (isBuy ? 'ST1_RENKO_LAST_BRICK_NOT_RED' : 'ST1_RENKO_LAST_BRICK_NOT_GREEN')
        : !rsiAligned
          ? (isBuy ? 'ST1_RENKO_RSI_NOT_BELOW_30' : 'ST1_RENKO_RSI_NOT_ABOVE_70')
          : (isBuy ? 'ST1_RENKO_LOWER_BB_NOT_REACHED' : 'ST1_RENKO_UPPER_BB_NOT_REACHED'),
    signal,
    brick: { ...lastBrick, open, high, low, close },
    boxSize: Number(boxSize),
    rsi,
    rsiMaximum: Number(settings.rsiMaximum),
    rsiMinimum: Number(settings.rsiMinimum),
    bollinger,
    toleranceT: Number(settings.bandToleranceT),
    tolerancePrice,
    distanceToLowerBand,
    distanceToUpperBand,
    entryOffsetT: Number(settings.entryOffsetT),
    targetPrice,
    setupCloseTime: finite(lastBrick?.closeTime),
    setupSignature: [
      finite(lastBrick?.closeTime) ?? 'NO_TIME',
      signal,
      Number(lastBrick?.id || 0),
      close.toPrecision(15),
      Number(boxSize).toPrecision(15)
    ].join(':')
  };
}

export function analyzeSimpleSt1RenkoSetup(candles, now = Date.now(), options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const closedCandles = (Array.isArray(candles) ? candles : []).filter((candle) => {
    const closeTime = finite(candle?.closeTime);
    return closeTime != null && closeTime <= now;
  });
  const boxSize = calculateAtr(closedCandles, settings.atrPeriod);
  if (!(boxSize > 0)) {
    return { triggered: false, reason: 'ST1_RENKO_ATR_INVALID', boxSize };
  }

  const bricks = generateRenkoBricks(closedCandles, boxSize, settings.maxBricks);
  const lastColor = bricks.at(-1)?.color;
  const signal = lastColor === 'RED' ? 'BUY' : lastColor === 'GREEN' ? 'SELL' : null;
  const analysis = analyzeSetupFromBricks(bricks, boxSize, signal, settings);
  return {
    ...analysis,
    sourceInterval: options.sourceInterval || '15m',
    sourceCandleCount: closedCandles.length,
    renkoBrickCount: Number(bricks.totalCount || bricks.length),
    retainedRenkoBrickCount: bricks.length
  };
}

export function hasCrossedEntryTarget(setup, currentPrice) {
  const price = finite(currentPrice);
  const target = finite(setup?.targetPrice);
  if (price == null || target == null || !['BUY', 'SELL'].includes(setup?.signal)) return false;
  return setup.signal === 'BUY' ? price > target : price < target;
}

export default {
  calculateAtr,
  generateRenkoBricks,
  calculateBollinger,
  calculateRsi,
  analyzeSetupFromBricks,
  analyzeSimpleSt1RenkoSetup,
  hasCrossedEntryTarget
};
