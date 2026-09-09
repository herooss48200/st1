import {
  analyzeSetupFromBricks,
  calculateRsi,
  generateRenkoBricks,
  hasCrossedEntryTarget
} from '../../src/engines/st1-renko-entry-engine.js';

function directionalBricks(color, count = 30, start = 100, boxSize = 1) {
  const finalDirection = color === 'GREEN' ? 1 : -1;
  const directions = Array.from({ length: count - 10 }, (_, index) => index % 2 === 0 ? 1 : -1)
    .concat(Array(10).fill(finalDirection));
  let price = start;
  return directions.map((direction, index) => {
    const open = price;
    const close = open + (direction * boxSize);
    price = close;
    return {
      id: index + 1,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      color: direction > 0 ? 'GREEN' : 'RED',
      closeTime: 1_000_000 + (index * 900_000)
    };
  });
}

function exactThresholdBricks(signal) {
  const changes = signal === 'BUY'
    ? [3, ...Array(12).fill(0), -7]
    : [-3, ...Array(12).fill(0), 7];
  const closes = [100];
  for (const change of changes) closes.push(closes.at(-1) + change);
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return {
      id: index + 1,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      color: close < open ? 'RED' : 'GREEN',
      closeTime: 1_000_000 + (index * 900_000)
    };
  });
}

describe('ST1 simple 15m Renko entry engine', () => {
  test('LONG pusu requires the last closed red brick RSI to be strictly below 30', () => {
    const bricks = directionalBricks('RED');
    const result = analyzeSetupFromBricks(bricks, 1, 'BUY');

    expect(result.triggered).toBe(true);
    expect(result.rsi).toBeLessThan(30);
    expect(result.brick.color).toBe('RED');
    expect(result.targetPrice).toBeCloseTo(result.brick.high + 0.25, 12);
  });

  test('SHORT pusu requires the last closed green brick RSI to be strictly above 70', () => {
    const bricks = directionalBricks('GREEN');
    const result = analyzeSetupFromBricks(bricks, 1, 'SELL');

    expect(result.triggered).toBe(true);
    expect(result.rsi).toBeGreaterThan(70);
    expect(result.brick.color).toBe('GREEN');
    expect(result.targetPrice).toBeCloseTo(result.brick.low - 0.25, 12);
  });

  test('RSI comparisons are strict rather than inclusive', () => {
    const longAt30 = analyzeSetupFromBricks(exactThresholdBricks('BUY'), 1, 'BUY', { bollingerPeriod: 15 });
    const shortAt70 = analyzeSetupFromBricks(exactThresholdBricks('SELL'), 1, 'SELL', { bollingerPeriod: 15 });

    expect(longAt30.rsi).toBeCloseTo(30, 12);
    expect(longAt30.triggered).toBe(false);
    expect(longAt30.reason).toBe('ST1_RENKO_RSI_NOT_BELOW_30');
    expect(shortAt70.rsi).toBeCloseTo(70, 12);
    expect(shortAt70.triggered).toBe(false);
    expect(shortAt70.reason).toBe('ST1_RENKO_RSI_NOT_ABOVE_70');
  });

  test('0.25T entry target must be crossed, equality is not enough', () => {
    const long = analyzeSetupFromBricks(directionalBricks('RED'), 1, 'BUY');
    const short = analyzeSetupFromBricks(directionalBricks('GREEN'), 1, 'SELL');

    expect(hasCrossedEntryTarget(long, long.targetPrice)).toBe(false);
    expect(hasCrossedEntryTarget(long, long.targetPrice + 0.000001)).toBe(true);
    expect(hasCrossedEntryTarget(short, short.targetPrice)).toBe(false);
    expect(hasCrossedEntryTarget(short, short.targetPrice - 0.000001)).toBe(true);
  });

  test('opposite brick color cannot arm the requested side', () => {
    expect(analyzeSetupFromBricks(directionalBricks('GREEN'), 1, 'BUY').reason)
      .toBe('ST1_RENKO_LAST_BRICK_NOT_RED');
    expect(analyzeSetupFromBricks(directionalBricks('RED'), 1, 'SELL').reason)
      .toBe('ST1_RENKO_LAST_BRICK_NOT_GREEN');
  });

  test('Renko construction keeps one-box continuation and two-box reversal behavior', () => {
    const candles = [
      { close: 100, closeTime: 1 },
      { close: 102, closeTime: 2 },
      { close: 100, closeTime: 3 }
    ];
    const bricks = generateRenkoBricks(candles, 1);

    expect(bricks.map((brick) => brick.color)).toEqual(['GREEN', 'GREEN', 'RED']);
    expect(bricks.at(-1)).toEqual(expect.objectContaining({ open: 101, close: 100, high: 101, low: 100 }));
  });

  test('Wilder RSI uses Renko closes and returns neutral for a flat series', () => {
    expect(calculateRsi(Array(20).fill(100), 14)).toBe(50);
  });
});
