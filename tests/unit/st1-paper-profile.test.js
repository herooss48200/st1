import { TradingLoop } from '../../src/trading-loop.js';
import config from '../../src/config/config.js';

describe('ST1 R43.3 PAPER-only replay-confirmed LONG profile', () => {
  test('uses 50 USDT cap, 300-coin universe and unlimited aggregate PAPER slots', () => {
    expect(config.TRADE_SIZE_USDT).toBe(50);
    expect(config.TOP_COINS_COUNT).toBe(300);
    expect(config.PAPER_UNLIMITED_POSITIONS).toBe(true);
    expect(config.MAX_POSITIONS).toBe(25);
    expect(config.LIVE_MAX_POSITIONS_HARD_CAP).toBe(25);
    expect(config.LIVE_MAX_TRADE_SIZE_USDT).toBe(50);
    expect(config.LIVE_MAX_TOTAL_NOTIONAL_USDT).toBe(1250);
    expect(config.MAX_POSITIONS_PER_COIN).toBe(1);
    expect(config.ST1_ENTRY_FUNNEL_RADAR_ENABLED).toBe(true);
    expect(config.ST1_RESCUE_RADAR_ENABLED).toBe(false);
    expect(config.ST1_RESCUE_RADAR_PAPER_CLOSE_ENABLED).toBe(false);
    expect(config.ST1_RESCUE_RADAR_LIVE_CLOSE_ENABLED).toBe(false);
  });

  test('trading loop resolves PAPER aggregate capacity as unlimited', () => {
    const loop = new TradingLoop({}, {});
    expect(loop.isUnlimitedPaperPositions()).toBe(true);
    expect(loop.resolveMaxPositions()).toBe(Number.POSITIVE_INFINITY);
  });

  test('keeps BTC15 SuperTrend out of the ST1 final entry authority', () => {
    expect(config.STRICT_FINAL_SUPERTREND_GATE).toBe(false);
  });

  test('keeps the default boot profile fail-closed in PAPER', () => {
    expect(config.APP_MODE).toBe('paper');
    expect(config.ENABLE_REAL_TRADING).toBe(false);
    expect(config.ST1_PAPER_ONLY).toBe(true);
    expect(config.LEVERAGE).toBe(10);
    expect(config.APP_VERSION).toBe('ST1-R43.3-LONG-RSI-FLOW-PAPER');
    expect(config.ST1_SIMPLE_RENKO_ENTRY_ENABLED).toBe(true);
    expect(config.ST1_RENKO_SOURCE_INTERVAL).toBe('15m');
    expect(config.ST1_RENKO_RSI_OVERSOLD).toBe(30);
    expect(config.ST1_RENKO_RSI_OVERBOUGHT).toBe(70);
    expect(config.ST1_RENKO_ENTRY_OFFSET_T).toBe(0.25);
    expect(config.ST1_ORDERFLOW_INTERVAL).toBe('1m');
    expect(config.ST1_ORDERFLOW_WINDOW_CANDLES).toBe(3);
    expect(config.ST1_ORDERFLOW_REQUIRED_CONFIRMATIONS).toBe(2);
    expect(config.ST1_ORDERFLOW_LONG_MIN_BUY_RATIO).toBeCloseTo(0.58, 12);
    expect(config.ST1_ORDERFLOW_SHORT_MAX_BUY_RATIO).toBeCloseTo(0.42, 12);
    expect(config.ST1_R433_ENTRY_GATE_ENABLED).toBe(true);
    expect(config.ST1_R433_LONG_RSI_MINIMUM).toBe(28);
    expect(config.ST1_R433_LONG_RSI_MAXIMUM_EXCLUSIVE).toBe(30);
    expect(config.ST1_R433_LONG_FLOW_MINIMUM).toBeCloseTo(0.58, 12);
    expect(config.ST1_R433_LONG_FLOW_MAXIMUM).toBeCloseTo(0.72, 12);
    expect(config.ST1_SCIENTIFIC_SHADOW_ENABLED).toBe(true);
    expect(config.ST1_SHADOW_RSI_PROXIMITY_POINTS).toBe(2);
    expect(config.ST1_SHADOW_LONG_FLOW_MAX_BUY_RATIO).toBeCloseTo(0.72, 12);
    expect(config.ST1_SHADOW_EARLY_LOCK_TRIGGER_PERCENT).toBeCloseTo(0.30, 12);
    expect(config.ST1_SHADOW_STALE_MINUTES).toBe(240);
    expect(config.ST1_RENKO_MAX_CHASE_T).toBeCloseTo(0.25, 12);
  });
});
