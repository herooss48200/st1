import { TradingLoop } from '../../src/trading-loop.js';
import config from '../../src/config/config.js';

describe('ST1 R41.1 PAPER final profile', () => {
  test('uses 50 USDT cap, 300-coin universe and unlimited aggregate PAPER slots', () => {
    expect(config.TRADE_SIZE_USDT).toBe(50);
    expect(config.TOP_COINS_COUNT).toBe(300);
    expect(config.PAPER_UNLIMITED_POSITIONS).toBe(true);
    expect(config.MAX_POSITIONS).toBe(5); // reserved future LIVE safety cap
    expect(config.MAX_POSITIONS_PER_COIN).toBe(1);
    expect(config.ST1_ENTRY_FUNNEL_RADAR_ENABLED).toBe(true);
    expect(config.ST1_RESCUE_RADAR_ENABLED).toBe(true);
    expect(config.ST1_RESCUE_RADAR_PAPER_CLOSE_ENABLED).toBe(true);
  });

  test('trading loop resolves PAPER aggregate capacity as unlimited', () => {
    const loop = new TradingLoop({}, {});
    expect(loop.isUnlimitedPaperPositions()).toBe(true);
    expect(loop.resolveMaxPositions()).toBe(Number.POSITIVE_INFINITY);
  });

  test('keeps BTC15 SuperTrend out of the ST1 final entry authority', () => {
    expect(config.STRICT_FINAL_SUPERTREND_GATE).toBe(false);
  });
});
