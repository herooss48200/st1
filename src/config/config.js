import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import AGROS_POLICY from './agros-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Jest supplies an isolated environment; never let a developer's .env alter tests.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(__dirname, '../../.env') });
}

// Non-secret runtime and strategy values live in agros-policy.js.
// Shell/PM2 environment variables may still override them intentionally.
for (const [key, value] of Object.entries(AGROS_POLICY)) {
  if (process.env[key] == null) {
    process.env[key] = String(value);
  }
}

class Config {
  constructor() {
    this.validateRequiredEnvVars();
    this.initializeConfig();
  }

  validateRequiredEnvVars() {
    const required = ['APP_MODE', 'NODE_ENV'];
    const mode = String(process.env.APP_MODE || 'paper').toLowerCase();

    // PAPER intentionally uses public Futures market data without exchange secrets.
    // LIVE remains fail-closed and requires explicit Binance credentials.
    if (mode === 'live') required.push('BINANCE_API_KEY', 'BINANCE_API_SECRET');

    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  initializeConfig() {
    const integer = (name, fallback) => {
      const value = Number.parseInt(process.env[name], 10);
      return Number.isFinite(value) ? value : fallback;
    };
    const number = (name, fallback) => {
      const value = Number.parseFloat(process.env[name]);
      return Number.isFinite(value) ? value : fallback;
    };
    const boolean = (name, fallback) => process.env[name] == null
      ? fallback
      : process.env[name] === 'true';
    // Application
    this.APP_MODE = process.env.APP_MODE || 'paper';
    this.NODE_ENV = process.env.NODE_ENV || 'development';
    this.ENABLE_REAL_TRADING = boolean('ENABLE_REAL_TRADING', false);
    this.PAPER_UNLIMITED_POSITIONS = boolean('PAPER_UNLIMITED_POSITIONS', true);
    this.MAINTENANCE_MODE = boolean('MAINTENANCE_MODE', false);
    this.MAINTENANCE_MESSAGE = process.env.MAINTENANCE_MESSAGE || '';
    this.HEALTH_HOST = process.env.HEALTH_HOST || '0.0.0.0';
    this.HEALTH_PORT = integer('HEALTH_PORT', 3000);

    // Validation
    if (!['paper', 'testnet', 'live'].includes(this.APP_MODE)) {
      throw new Error(`Invalid APP_MODE: ${this.APP_MODE}`);
    }

    if (this.APP_MODE === 'live' && !this.ENABLE_REAL_TRADING) {
      throw new Error('ENABLE_REAL_TRADING must be true for live mode');
    }

    if (this.APP_MODE === 'paper' && this.ENABLE_REAL_TRADING) {
      throw new Error('PAPER mode cannot enable real trading');
    }

    // Binance
    this.BINANCE_API_KEY = process.env.BINANCE_API_KEY;
    this.BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
    this.BINANCE_TESTNET_API_KEY = process.env.BINANCE_TESTNET_API_KEY;
    this.BINANCE_TESTNET_API_SECRET = process.env.BINANCE_TESTNET_API_SECRET;
    this.BINANCE_LIVE_BASE_URL = process.env.BINANCE_LIVE_BASE_URL || 'https://fapi.binance.com';
    this.BINANCE_TESTNET_BASE_URL = process.env.BINANCE_TESTNET_BASE_URL || 'https://testnet.binancefuture.com';
    this.BINANCE_WEBSOCKET_URL = process.env.BINANCE_WEBSOCKET_URL || 'wss://fstream.binance.com/ws';
    this.BINANCE_RECV_WINDOW_MS = integer('BINANCE_RECV_WINDOW_MS', 5000);
    this.BINANCE_URL = this.getBinanceUrl();

    // Database
    this.DATABASE_URL = process.env.DATABASE_URL || 'sqlite:./data/gptsono.db';
    this.DATABASE_POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX) || 10;
    this.DATABASE_POOL_MIN = parseInt(process.env.DATABASE_POOL_MIN) || 2;

    // Telegram
    this.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    this.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    this.ENABLE_TELEGRAM = boolean('ENABLE_TELEGRAM', true);
    this.TELEGRAM_API_BASE_URL = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org';
    this.TELEGRAM_REQUEST_TIMEOUT_MS = integer('TELEGRAM_REQUEST_TIMEOUT_MS', 5000);
    this.TELEGRAM_RETRY_ATTEMPTS = integer('TELEGRAM_RETRY_ATTEMPTS', 3);
    this.TELEGRAM_RETRY_DELAY_MS = integer('TELEGRAM_RETRY_DELAY_MS', 1000);
    this.PERFORMANCE_REPORT_INTERVAL_MS = integer('PERFORMANCE_REPORT_INTERVAL_MS', 1800000);
    this.BOOTSTRAP_STEP_DELAY_MS = integer('BOOTSTRAP_STEP_DELAY_MS', 100);

    // Trading
    this.LEVERAGE = integer('LEVERAGE', 10);
    this.POSITION_SIZE_PERCENT = parseFloat(process.env.POSITION_SIZE_PERCENT) || 2;
    this.MAX_POSITIONS = integer('MAX_POSITIONS', 15);
    this.MAX_DAILY_LOSS_PERCENT = parseFloat(process.env.MAX_DAILY_LOSS_PERCENT) || 5;
    this.MAX_DAILY_TRADES = parseInt(process.env.MAX_DAILY_TRADES) || 20000;
    this.TRADE_SIZE_USDT = number('TRADE_SIZE_USDT', 100);
    this.PAPER_WALLET_START_USDT = number('PAPER_WALLET_START_USDT', 10000);
    this.COMMISSION_RATE = number('COMMISSION_RATE', 0.0004);
    this.INITIAL_TP_PERCENT = number('INITIAL_TP_PERCENT', 1);
    this.STOP_LOSS_PERCENT = number('STOP_LOSS_PERCENT', 1);
    this.BREAK_EVEN_TRIGGER_PERCENT = number('BREAK_EVEN_TRIGGER_PERCENT', 0.6);
    this.CONFIRMATION_BODY_RATIO = number('CONFIRMATION_BODY_RATIO', 0.55);
    this.CONFIRMATION_VOLUME_MULTIPLIER = number('CONFIRMATION_VOLUME_MULTIPLIER', 1.5);
    this.PRE_TRADE_MIN_RISK_REWARD_RATIO = number('PRE_TRADE_MIN_RISK_REWARD_RATIO', 1);
    this.RISK_REWARD_EPSILON = number('RISK_REWARD_EPSILON', 1e-9);
    this.ESTIMATED_SLIPPAGE_PERCENT = number('ESTIMATED_SLIPPAGE_PERCENT', 0.05);
    this.MIN_EXPECTED_NET_ADVANTAGE_USDT = number('MIN_EXPECTED_NET_ADVANTAGE_USDT', 0.01);
    this.MAX_DAILY_COMMISSION_USDT = number('MAX_DAILY_COMMISSION_USDT', 25);
    this.MAX_DAILY_TURNOVER_USDT = number('MAX_DAILY_TURNOVER_USDT', 10000);
    this.REQUIRED_CONFIRMATION_COUNT = integer('REQUIRED_CONFIRMATION_COUNT', 1);
    this.REJECT_VOLUME_ONLY_CONFIRMATION = boolean('REJECT_VOLUME_ONLY_CONFIRMATION', true);
    this.OWNERSHIP_WARNING_COOLDOWN_MS = integer('OWNERSHIP_WARNING_COOLDOWN_MS', 30000);
    this.BOT_NAME = String(process.env.BOT_NAME || 'ST1');
    this.APP_VERSION = String(process.env.APP_VERSION || 'ST1');

    // Similarity Engine
    this.SIMILARITY_THRESHOLD = integer('SIMILARITY_THRESHOLD', 52);
    this.SIMILARITY_WINDOW_SIZE = parseInt(process.env.SIMILARITY_WINDOW_SIZE) || 120;
    this.TOP_COINS_COUNT = parseInt(process.env.TOP_COINS_COUNT) || 100;
    this.EXCLUDED_ENTRY_SYMBOLS = new Set(
      String(process.env.EXCLUDED_ENTRY_SYMBOLS || 'XAUTUSDT,PAXGUSDT,BTCDOMUSDT')
        .split(',')
        .map(symbol => symbol.trim().toUpperCase())
        .filter(Boolean)
    );
    this.SIMILARITY_BTC_WEIGHT = parseInt(process.env.SIMILARITY_BTC_WEIGHT) || 85;
    this.SIMILARITY_ETH_WEIGHT = parseInt(process.env.SIMILARITY_ETH_WEIGHT) || 15;
    this.SIMILARITY_INTERVAL = process.env.SIMILARITY_INTERVAL || '4h';
    this.READY_BOLLINGER_INTERVAL = process.env.READY_BOLLINGER_INTERVAL || '15m';
    this.AMBUSH_TIMEOUT_MINUTES = integer('AMBUSH_TIMEOUT_MINUTES', 15);
    this.SIMILARITY_WEIGHTS = {
      pearson: number('SIMILARITY_WEIGHT_PEARSON', 15) / 100,
      body: number('SIMILARITY_WEIGHT_BODY', 12) / 100,
      wick_upper: number('SIMILARITY_WEIGHT_WICK_UPPER', 10) / 100,
      wick_lower: number('SIMILARITY_WEIGHT_WICK_LOWER', 10) / 100,
      range: number('SIMILARITY_WEIGHT_RANGE', 10) / 100,
      volume: number('SIMILARITY_WEIGHT_VOLUME', 10) / 100,
      momentum: number('SIMILARITY_WEIGHT_MOMENTUM', 13) / 100,
      trend: number('SIMILARITY_WEIGHT_TREND', 12) / 100,
      pattern: number('SIMILARITY_WEIGHT_PATTERN', 8) / 100
    };

    // Weighted market trend: BTC 50% + ETH 25% + market breadth 25%.
    this.MARKET_BREADTH_MODE = String(process.env.MARKET_BREADTH_MODE || 'WEIGHTED_TREND').trim().toUpperCase();
    this.MARKET_TREND_BTC_WEIGHT = number('MARKET_TREND_BTC_WEIGHT', 50);
    this.MARKET_TREND_ETH_WEIGHT = number('MARKET_TREND_ETH_WEIGHT', 25);
    this.MARKET_TREND_BREADTH_WEIGHT = number('MARKET_TREND_BREADTH_WEIGHT', 25);
    this.MARKET_TREND_ENTRY_SCORE = number('MARKET_TREND_ENTRY_SCORE', 0.35);
    this.MARKET_TREND_STRONG_SCORE = number('MARKET_TREND_STRONG_SCORE', 0.65);
    this.MARKET_BREADTH_TOP_COINS = integer('MARKET_BREADTH_TOP_COINS', 200);
    this.MARKET_BREADTH_CANDIDATE_MULTIPLIER = integer('MARKET_BREADTH_CANDIDATE_MULTIPLIER', 2);
    this.MARKET_BREADTH_UNIVERSE_TTL_MS = integer('MARKET_BREADTH_UNIVERSE_TTL_MS', 3600000);
    this.MARKET_BREADTH_15M_CONCURRENCY = integer('MARKET_BREADTH_15M_CONCURRENCY', 10);
    this.MARKET_BREADTH_15M_CACHE_TTL_MS = integer('MARKET_BREADTH_15M_CACHE_TTL_MS', 900000);
    this.MARKET_BREADTH_MAX_RESULT_AGE_MS = integer('MARKET_BREADTH_MAX_RESULT_AGE_MS', 960000);
    this.MARKET_BREADTH_MIN_VALID_COINS = integer('MARKET_BREADTH_MIN_VALID_COINS', 30);
    this.MARKET_BREADTH_FLAT_THRESHOLD_PERCENT = number('MARKET_BREADTH_FLAT_THRESHOLD_PERCENT', 0.10);
    this.MARKET_BREADTH_ENTER_THRESHOLD_PERCENT = number('MARKET_BREADTH_ENTER_THRESHOLD_PERCENT', 60);
    this.MARKET_BREADTH_EXIT_THRESHOLD_PERCENT = number('MARKET_BREADTH_EXIT_THRESHOLD_PERCENT', 55);
    this.MARKET_BREADTH_ENTRY_VETO_ENABLED = boolean('MARKET_BREADTH_ENTRY_VETO_ENABLED', true);
    this.MARKET_BREADTH_NEUTRAL_RISK_USDT = number('MARKET_BREADTH_NEUTRAL_RISK_USDT', 0.5);
    this.MARKET_BREADTH_OPPOSED_RISK_USDT = number('MARKET_BREADTH_OPPOSED_RISK_USDT', 0.25);

    // BTC Trend
    this.BTC_TREND_LOOKBACK = parseInt(process.env.BTC_TREND_LOOKBACK) || 20;
    this.BTC_TREND_EMA_FAST_PERIOD = parseInt(process.env.BTC_TREND_EMA_FAST_PERIOD) || 50;
    this.BTC_TREND_EMA_SLOW_PERIOD = parseInt(process.env.BTC_TREND_EMA_SLOW_PERIOD) || 200;
    this.BTC_TREND_EMA_SIDEWAYS_THRESHOLD_PERCENT = parseFloat(process.env.BTC_TREND_EMA_SIDEWAYS_THRESHOLD_PERCENT) || 0.1;
    this.BTC_TREND_INTERVAL = process.env.BTC_TREND_INTERVAL || '15m';
    this.BTC_TREND_CANDLE_LIMIT = parseInt(process.env.BTC_TREND_CANDLE_LIMIT) || 250;
    this.STRICT_FINAL_SUPERTREND_GATE = boolean('STRICT_FINAL_SUPERTREND_GATE', false);
    this.FINAL_SUPERTREND_PERIOD = integer('FINAL_SUPERTREND_PERIOD', 10);
    this.FINAL_SUPERTREND_MULTIPLIER = number('FINAL_SUPERTREND_MULTIPLIER', 3);
    this.ST1_ENTRY_FUNNEL_RADAR_ENABLED = boolean('ST1_ENTRY_FUNNEL_RADAR_ENABLED', true);
    this.ST1_RESCUE_RADAR_ENABLED = boolean('ST1_RESCUE_RADAR_ENABLED', true);
    this.ST1_RESCUE_RADAR_PAPER_CLOSE_ENABLED = boolean('ST1_RESCUE_RADAR_PAPER_CLOSE_ENABLED', true);
    this.ST1_RESCUE_RADAR_CANDLE_LIMIT = integer('ST1_RESCUE_RADAR_CANDLE_LIMIT', 220);
    this.ST1_RESCUE_RADAR_ST1_RECENT_MINUTES = number('ST1_RESCUE_RADAR_ST1_RECENT_MINUTES', 20);
    this.ST1_RESCUE_RADAR_ST1_BB_TOLERANCE_PERCENT = number('ST1_RESCUE_RADAR_ST1_BB_TOLERANCE_PERCENT', 0.10);
    this.ST1_RESCUE_RADAR_YELLOW_BTC5_BB_PERCENT_B = number('ST1_RESCUE_RADAR_YELLOW_BTC5_BB_PERCENT_B', 1.0);
    this.ST1_RESCUE_RADAR_YELLOW_BTC15_EMA50_DISTANCE_PERCENT = number('ST1_RESCUE_RADAR_YELLOW_BTC15_EMA50_DISTANCE_PERCENT', 1.50);
    this.ST1_RESCUE_RADAR_ORANGE_FAST_MOVE_5M_PERCENT = number('ST1_RESCUE_RADAR_ORANGE_FAST_MOVE_5M_PERCENT', 0.30);
    this.ST1_RESCUE_RADAR_FAST_RED_MOVE_5M_PERCENT = number('ST1_RESCUE_RADAR_FAST_RED_MOVE_5M_PERCENT', 0.45);
    this.ST1_RESCUE_RADAR_FAST_RED_MIN_POSITIONS = integer('ST1_RESCUE_RADAR_FAST_RED_MIN_POSITIONS', 3);
    this.ST1_RESCUE_RADAR_FAST_RED_NEGATIVE_RATIO = number('ST1_RESCUE_RADAR_FAST_RED_NEGATIVE_RATIO', 0.70);
    this.ST1_RESCUE_RADAR_FAST_RED_PNL_DELTA_3M_USDT = number('ST1_RESCUE_RADAR_FAST_RED_PNL_DELTA_3M_USDT', -1.0);
    this.ST1_RESCUE_RADAR_SLOW_RED_MOVE_10M_PERCENT = number('ST1_RESCUE_RADAR_SLOW_RED_MOVE_10M_PERCENT', 0.30);
    this.ST1_RESCUE_RADAR_SLOW_RED_MIN_POSITIONS = integer('ST1_RESCUE_RADAR_SLOW_RED_MIN_POSITIONS', 3);
    this.ST1_RESCUE_RADAR_SLOW_RED_NEGATIVE_RATIO = number('ST1_RESCUE_RADAR_SLOW_RED_NEGATIVE_RATIO', 2 / 3);
    this.ST1_RESCUE_RADAR_SLOW_RED_BTC15_EMA50_MIN_DISTANCE_PERCENT = number('ST1_RESCUE_RADAR_SLOW_RED_BTC15_EMA50_MIN_DISTANCE_PERCENT', 0.30);
    this.ST1_RESCUE_RADAR_DIRECTION_FLIP_MIN_POSITIONS = integer('ST1_RESCUE_RADAR_DIRECTION_FLIP_MIN_POSITIONS', 3);
    this.ST1_RESCUE_RADAR_DIRECTION_FLIP_NEGATIVE_RATIO = number('ST1_RESCUE_RADAR_DIRECTION_FLIP_NEGATIVE_RATIO', 0.50);
    this.ST1_RESCUE_RADAR_RECOVERY_CONFIRM_MS = integer('ST1_RESCUE_RADAR_RECOVERY_CONFIRM_MS', 180000);
    this.BTC_SYMBOL = process.env.BTC_SYMBOL || 'BTCUSDT';
    this.ETH_SYMBOL = process.env.ETH_SYMBOL || 'ETHUSDT';
    const parsedAmbushRefreshIntervalMinutes = parseInt(process.env.AMBUSH_REFRESH_INTERVAL_MINUTES, 10);
    this.AMBUSH_REFRESH_INTERVAL_MINUTES = Number.isFinite(parsedAmbushRefreshIntervalMinutes)
      ? parsedAmbushRefreshIntervalMinutes
      : 15;
    this.AMBUSH_MONITOR_INTERVAL_MS = integer('AMBUSH_MONITOR_INTERVAL_MS', 60000);
    const parsedPositionMonitorIntervalMs = parseInt(process.env.POSITION_MONITOR_INTERVAL_MS, 10);
    this.POSITION_MONITOR_INTERVAL_MS = Number.isFinite(parsedPositionMonitorIntervalMs)
      ? parsedPositionMonitorIntervalMs
      : 5000;
    this.STRATEGY_CANDLE_INTERVAL_MS = integer('STRATEGY_CANDLE_INTERVAL_MS', 900000);
    this.STRATEGY_CANDLE_CLOSE_DELAY_MS = integer('STRATEGY_CANDLE_CLOSE_DELAY_MS', 5000);

    // Bollinger Bands
    this.BOLLINGER_PERIOD = parseInt(process.env.BOLLINGER_PERIOD) || 20;
    this.BOLLINGER_STD_DEV = parseFloat(process.env.BOLLINGER_STD_DEV) || 2;
    this.BOLLINGER_SOURCE = process.env.BOLLINGER_SOURCE || 'close';
    this.ST1_ENTRY_ENGINE_ENABLED = boolean('ST1_ENTRY_ENGINE_ENABLED', true);
    this.ST1_BB_TOUCH_ATR_MULTIPLIER = number('ST1_BB_TOUCH_ATR_MULTIPLIER', 0.10);
    this.ST1_ENTRY_WINDOW_CANDLES = integer('ST1_ENTRY_WINDOW_CANDLES', 3);
    this.ST1_COIN_EMA_FAST_PERIOD = integer('ST1_COIN_EMA_FAST_PERIOD', 50);
    this.ST1_COIN_EMA_SLOW_PERIOD = integer('ST1_COIN_EMA_SLOW_PERIOD', 200);
    this.ST1_COIN_SUPERTREND_PERIOD = integer('ST1_COIN_SUPERTREND_PERIOD', 10);
    this.ST1_COIN_SUPERTREND_MULTIPLIER = number('ST1_COIN_SUPERTREND_MULTIPLIER', 3);
    this.TRIGGER_INTERVAL = process.env.TRIGGER_INTERVAL || '1m';
    this.FULL_ALIGNMENT_EMA_READY_ENABLED = boolean('FULL_ALIGNMENT_EMA_READY_ENABLED', true);
    this.FULL_ALIGNMENT_EMA_PERIOD = integer('FULL_ALIGNMENT_EMA_PERIOD', 50);
    this.FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER = number('FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER', 0.10);
    this.FULL_ALIGNMENT_EMA_REQUIRE_RECLAIM = boolean('FULL_ALIGNMENT_EMA_REQUIRE_RECLAIM', true);
    this.FULL_ALIGNMENT_EMA_REQUIRE_SLOPE = boolean('FULL_ALIGNMENT_EMA_REQUIRE_SLOPE', true);

    // Risk
    this.RISK_PERCENT = parseFloat(process.env.RISK_PERCENT) || 2;
    this.TP_PERCENT = parseFloat(process.env.TP_PERCENT) || 5;
    this.SL_PERCENT = parseFloat(process.env.SL_PERCENT) || 2;
    this.TRAILING_ATR_MULTIPLIER = parseFloat(process.env.TRAILING_ATR_MULTIPLIER) || 2;
    this.BREAK_EVEN_PROFIT_PERCENT = parseFloat(process.env.BREAK_EVEN_PROFIT_PERCENT) || 1;
    const parsedAtrPeriod = parseInt(process.env.ATR_PERIOD, 10);
    const parsedBeAtrMultiplier = parseFloat(process.env.BE_ATR_MULTIPLIER);
    const parsedTrailingActivationAtrMultiplier = parseFloat(process.env.TRAILING_ACTIVATION_ATR_MULTIPLIER);
    const parsedTpStepAtrMultiplier = parseFloat(process.env.TP_STEP_ATR_MULTIPLIER);
    const parsedMinTpStepPercent = parseFloat(process.env.MIN_TP_STEP_PERCENT);
    this.ATR_PERIOD = Number.isFinite(parsedAtrPeriod) ? parsedAtrPeriod : 14;
    this.BE_ATR_MULTIPLIER = Number.isFinite(parsedBeAtrMultiplier) ? parsedBeAtrMultiplier : 1.0;
    this.TRAILING_ACTIVATION_ATR_MULTIPLIER = Number.isFinite(parsedTrailingActivationAtrMultiplier)
      ? parsedTrailingActivationAtrMultiplier
      : 1.5;
    this.TP_STEP_ATR_MULTIPLIER = Number.isFinite(parsedTpStepAtrMultiplier) ? parsedTpStepAtrMultiplier : 0.5;
    this.MIN_TP_STEP_PERCENT = Number.isFinite(parsedMinTpStepPercent) ? parsedMinTpStepPercent : 0.5;
    this.POSITION_FOLLOW_MODE = String(process.env.POSITION_FOLLOW_MODE || 'STAGED_R_ATR').trim().toUpperCase();
    this.DELAYED_PROTECTION_ENABLED = boolean('DELAYED_PROTECTION_ENABLED', true);
    this.PROTECTION_DELAY_MIN_MS = integer('PROTECTION_DELAY_MIN_MS', 60000);
    this.PROTECTION_DELAY_MAX_MS = integer('PROTECTION_DELAY_MAX_MS', 240000);
    this.EMERGENCY_STOP_LOSS_PERCENT = number('EMERGENCY_STOP_LOSS_PERCENT', 1.5);
    this.MAX_INITIAL_STOP_PERCENT = number('MAX_INITIAL_STOP_PERCENT', 1.5);
    this.STRUCTURAL_SL_INTERVAL = String(process.env.STRUCTURAL_SL_INTERVAL || '15m').trim();
    this.STRUCTURAL_SL_LOOKBACK = integer('STRUCTURAL_SL_LOOKBACK', 20);
    this.STRUCTURAL_SL_BUFFER_PERCENT = number('STRUCTURAL_SL_BUFFER_PERCENT', 0.1);
    this.STRUCTURAL_SL_ATR_BUFFER_MULTIPLIER = number('STRUCTURAL_SL_ATR_BUFFER_MULTIPLIER', 0.5);
    this.FIRST_PROFIT_LOCK_PERCENT = number('FIRST_PROFIT_LOCK_PERCENT', 0.5);
    this.DELAYED_TRAILING_INITIAL_ATR_MULTIPLIER = number('DELAYED_TRAILING_INITIAL_ATR_MULTIPLIER', 2.5);
    this.DELAYED_TRAILING_TIGHTEN_R_MULTIPLIER = number('DELAYED_TRAILING_TIGHTEN_R_MULTIPLIER', 1.5);
    this.PROFIT_LOCK_STAGE_1_TRIGGER_R = number('PROFIT_LOCK_STAGE_1_TRIGGER_R', 0.75);
    this.PROFIT_LOCK_STAGE_1_STOP_R = number('PROFIT_LOCK_STAGE_1_STOP_R', 0.25);
    this.PROFIT_LOCK_STAGE_2_TRIGGER_R = number('PROFIT_LOCK_STAGE_2_TRIGGER_R', 1.0);
    this.PROFIT_LOCK_STAGE_2_STOP_R = number('PROFIT_LOCK_STAGE_2_STOP_R', 0.5);
    // Absolute economic floor independent of structural R width.
    // Once price has reached +1.00%, lock at least +0.35% (defaults).
    this.PROFIT_LOCK_TRIGGER_PERCENT = number('PROFIT_LOCK_TRIGGER_PERCENT', 1.0);
    this.PROFIT_LOCK_STOP_PERCENT = number('PROFIT_LOCK_STOP_PERCENT', 0.35);
    this.STAGED_INITIAL_TP_R_MULTIPLIER = number('STAGED_INITIAL_TP_R_MULTIPLIER', 3);
    this.MIN_EFFECTIVE_STOP_PERCENT = number('MIN_EFFECTIVE_STOP_PERCENT', 0.5);
    this.RISK_PER_TRADE_USDT = number('RISK_PER_TRADE_USDT', 2);
    this.MIN_RISK_SIZED_TRADE_USDT = number('MIN_RISK_SIZED_TRADE_USDT', 5);
    this.STOP_UPDATE_MIN_TICKS = integer('STOP_UPDATE_MIN_TICKS', 1);
    this.STOP_UPDATE_COOLDOWN_MS = integer('STOP_UPDATE_COOLDOWN_MS', 10000);
    this.BREAK_EVEN_R_MULTIPLIER = number('BREAK_EVEN_R_MULTIPLIER', 1);
    this.BREAK_EVEN_MIN_ATR_MULTIPLIER = number('BREAK_EVEN_MIN_ATR_MULTIPLIER', 0.8);
    this.TRAILING_ACTIVATION_R_MULTIPLIER = number('TRAILING_ACTIVATION_R_MULTIPLIER', 1.5);
    this.TRAILING_ATR_NORMAL_MULTIPLIER = number('TRAILING_ATR_NORMAL_MULTIPLIER', 1.75);
    this.TRAILING_ATR_STRONG_TREND_MULTIPLIER = number('TRAILING_ATR_STRONG_TREND_MULTIPLIER', 2.25);
    this.TRAILING_ATR_WEAK_TREND_MULTIPLIER = number('TRAILING_ATR_WEAK_TREND_MULTIPLIER', 1.25);
    this.MAX_POSITIONS_PER_COIN = integer('MAX_POSITIONS_PER_COIN', 1);
    this.MAX_MONTHLY_LOSS_PERCENT = number('MAX_MONTHLY_LOSS_PERCENT', 5);
    this.RISK_ACCOUNT_BASE_USDT = number('RISK_ACCOUNT_BASE_USDT', 10000);

    // API & Performance
    this.API_RATE_LIMIT_WINDOW = parseInt(process.env.API_RATE_LIMIT_WINDOW) || 60000;
    this.API_REQUESTS_PER_WINDOW = integer('API_REQUESTS_PER_WINDOW', 1200);
    this.API_WEIGHT_PER_WINDOW = integer('API_WEIGHT_PER_WINDOW', 1200000);
    this.API_RETRY_MAX = parseInt(process.env.API_RETRY_MAX) || 3;
    this.API_RETRY_DELAY = parseInt(process.env.API_RETRY_DELAY) || 1000;
    this.ANALYSIS_TIMEOUT = parseInt(process.env.ANALYSIS_TIMEOUT) || 30000;
    this.WEBSOCKET_RECONNECT_DELAY = parseInt(process.env.WEBSOCKET_RECONNECT_DELAY) || 5000;
    this.WEBSOCKET_CONNECTION_TIMEOUT_MS = integer('WEBSOCKET_CONNECTION_TIMEOUT_MS', 10000);
    this.WEBSOCKET_MAX_RECONNECT_ATTEMPTS = integer('WEBSOCKET_MAX_RECONNECT_ATTEMPTS', 5);
    this.ORDER_RETRY_ATTEMPTS = integer('ORDER_RETRY_ATTEMPTS', 3);
    this.ORDER_RETRY_DELAY_MS = integer('ORDER_RETRY_DELAY_MS', 1000);
    this.ORDER_TIMEOUT_MS = integer('ORDER_TIMEOUT_MS', 30000);
    this.PROTECTION_RETRY_DELAYS_MS = (process.env.PROTECTION_RETRY_DELAYS_MS || '1000,2000,4000')
      .split(',').map(value => Number.parseInt(value.trim(), 10)).filter(Number.isFinite);
    this.PROTECTION_EMERGENCY_CLOSE_MAX_FAILURES = integer('PROTECTION_EMERGENCY_CLOSE_MAX_FAILURES', 3);
    this.EXCHANGE_API_REQUEST_TIMEOUT_MS = integer('EXCHANGE_API_REQUEST_TIMEOUT_MS', 10000);
    this.ORDER_EXCHANGE_INFO_TTL_MS = integer('ORDER_EXCHANGE_INFO_TTL_MS', 600000);
    this.ORDER_PRICE_CACHE_MIN_INTERVAL_MS = integer('ORDER_PRICE_CACHE_MIN_INTERVAL_MS', 2000);
    this.ORDER_PRICE_CACHE_MULTIPLIER = number('ORDER_PRICE_CACHE_MULTIPLIER', 2);
    this.ORDER_PRICE_CACHE_BUFFER_MS = integer('ORDER_PRICE_CACHE_BUFFER_MS', 1000);
    this.MARKET_DATA_REQUEST_TIMEOUT_MS = integer('MARKET_DATA_REQUEST_TIMEOUT_MS', 10000);
    this.CANDLE_REQUEST_CONCURRENCY = integer('CANDLE_REQUEST_CONCURRENCY', 8);
    this.CANDLE_RETRY_ATTEMPTS = integer('CANDLE_RETRY_ATTEMPTS', 3);
    this.CANDLE_RETRY_BASE_DELAY_MS = integer('CANDLE_RETRY_BASE_DELAY_MS', 250);
    this.CANDLE_CIRCUIT_FAILURE_THRESHOLD = integer('CANDLE_CIRCUIT_FAILURE_THRESHOLD', 10);
    this.CANDLE_CIRCUIT_OPEN_MS = integer('CANDLE_CIRCUIT_OPEN_MS', 60000);
    this.ORDER_BOOK_DEFAULT_LIMIT = integer('ORDER_BOOK_DEFAULT_LIMIT', 100);
    this.DATABASE_QUERY_DEFAULT_LIMIT = integer('DATABASE_QUERY_DEFAULT_LIMIT', 100);

    // Feature Flags
    this.ENABLE_SIMILARITY_ANALYSIS = process.env.ENABLE_SIMILARITY_ANALYSIS !== 'false';
    this.ENABLE_SNIPER = process.env.ENABLE_SNIPER !== 'false';
    this.ENABLE_TRAILING_STOP = process.env.ENABLE_TRAILING_STOP !== 'false';
    this.ENABLE_BREAK_EVEN = process.env.ENABLE_BREAK_EVEN !== 'false';

    // Logging
    this.LOG_LEVEL = process.env.LOG_LEVEL || 'info';
    this.LOG_FILE = process.env.LOG_FILE || 'logs/gptsono.log';
    this.LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '10m';
    this.LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES) || 10;
    this.LOG_ERROR_FILE = process.env.LOG_ERROR_FILE || 'logs/error.log';
    this.LOG_ERROR_MAX_FILES = integer('LOG_ERROR_MAX_FILES', 5);

    // Cache
    this.CACHE_TTL = parseInt(process.env.CACHE_TTL) || 3600000;
    this.MARKET_DATA_REFRESH_INTERVAL = parseInt(process.env.MARKET_DATA_REFRESH_INTERVAL) || 300000;
    this.SIMILARITY_RECALC_INTERVAL = parseInt(process.env.SIMILARITY_RECALC_INTERVAL) || 3600000;
    this.CACHE_CLEANUP_INTERVAL_MS = integer('CACHE_CLEANUP_INTERVAL_MS', 30000);
    this.HISTORICAL_CACHE_MIN_CANDLES = integer('HISTORICAL_CACHE_MIN_CANDLES', 0);
    this.CANDLE_COLLECTION_INTERVAL_MS = integer('CANDLE_COLLECTION_INTERVAL_MS', 3600000);
    this.INDICATOR_CACHE_TTL_MS = integer('INDICATOR_CACHE_TTL_MS', 60000);
    this.HEALTH_DATA_MAX_AGE_MS = integer('HEALTH_DATA_MAX_AGE_MS', 5000);
    this.HEARTBEAT_INTERVAL_MS = integer('HEARTBEAT_INTERVAL_MS', 30000);
    this.SNAPSHOT_PRICE_TOLERANCE_RATIO = number('SNAPSHOT_PRICE_TOLERANCE_RATIO', 0.01);
    this.NOTIFICATION_DEFAULT_WALLET_USDT = number('NOTIFICATION_DEFAULT_WALLET_USDT', 1000);
    this.ACCOUNTING_STATE_FILE = String(process.env.ACCOUNTING_STATE_FILE || 'data/accounting-state.json');
    this.RECOVERY_INTERVAL_MS = integer('RECOVERY_INTERVAL_MS', 60000);
    this.RECOVERY_MAX_RETRIES = integer('RECOVERY_MAX_RETRIES', 5);
    this.RECOVERY_BACKOFF_MULTIPLIER = number('RECOVERY_BACKOFF_MULTIPLIER', 2);
    this.RECOVERY_BASE_DELAY_MS = integer('RECOVERY_BASE_DELAY_MS', 1000);
    this.RECOVERY_MAX_DELAY_MS = integer('RECOVERY_MAX_DELAY_MS', 30000);
  }

  // Get config as frozen object
  get() {
    return Object.freeze({ ...this });
  }

  // Validate config on load
  validate() {
    if (this.MARKET_BREADTH_MODE !== 'WEIGHTED_TREND') {
      throw new Error('MARKET_BREADTH_MODE must be WEIGHTED_TREND');
    }

    const marketTrendWeightTotal = this.MARKET_TREND_BTC_WEIGHT
      + this.MARKET_TREND_ETH_WEIGHT
      + this.MARKET_TREND_BREADTH_WEIGHT;
    if (marketTrendWeightTotal !== 100) {
      throw new Error(`MARKET_TREND weights must sum to 100. Current: ${marketTrendWeightTotal}`);
    }
    if (this.MARKET_TREND_ENTRY_SCORE <= 0 || this.MARKET_TREND_ENTRY_SCORE >= 1) {
      throw new Error('MARKET_TREND_ENTRY_SCORE must be between 0 and 1');
    }
    if (this.MARKET_TREND_STRONG_SCORE < this.MARKET_TREND_ENTRY_SCORE || this.MARKET_TREND_STRONG_SCORE > 1) {
      throw new Error('MARKET_TREND_STRONG_SCORE must be between entry score and 1');
    }

    if (this.MARKET_BREADTH_ENTER_THRESHOLD_PERCENT <= this.MARKET_BREADTH_EXIT_THRESHOLD_PERCENT) {
      throw new Error('MARKET_BREADTH_ENTER_THRESHOLD_PERCENT must be greater than exit threshold');
    }

    if (!Number.isInteger(this.MARKET_BREADTH_TOP_COINS) || this.MARKET_BREADTH_TOP_COINS <= 0) {
      throw new Error('MARKET_BREADTH_TOP_COINS must be a positive integer');
    }

    if (!Number.isInteger(this.MARKET_BREADTH_CANDIDATE_MULTIPLIER) || this.MARKET_BREADTH_CANDIDATE_MULTIPLIER < 1) {
      throw new Error('MARKET_BREADTH_CANDIDATE_MULTIPLIER must be a positive integer');
    }

    if (!Number.isFinite(this.MARKET_BREADTH_NEUTRAL_RISK_USDT) || this.MARKET_BREADTH_NEUTRAL_RISK_USDT <= 0) {
      throw new Error('MARKET_BREADTH_NEUTRAL_RISK_USDT must be greater than 0');
    }
    if (!Number.isFinite(this.MARKET_BREADTH_OPPOSED_RISK_USDT) || this.MARKET_BREADTH_OPPOSED_RISK_USDT <= 0) {
      throw new Error('MARKET_BREADTH_OPPOSED_RISK_USDT must be greater than 0');
    }

    if (this.SIMILARITY_THRESHOLD < 0 || this.SIMILARITY_THRESHOLD > 100) {
      throw new Error('SIMILARITY_THRESHOLD must be between 0 and 100');
    }

    if (!Number.isFinite(this.ST1_BB_TOUCH_ATR_MULTIPLIER) || this.ST1_BB_TOUCH_ATR_MULTIPLIER < 0) {
      throw new Error('ST1_BB_TOUCH_ATR_MULTIPLIER must be 0 or greater');
    }
    if (!Number.isInteger(this.ST1_ENTRY_WINDOW_CANDLES) || this.ST1_ENTRY_WINDOW_CANDLES < 1) {
      throw new Error('ST1_ENTRY_WINDOW_CANDLES must be a positive integer');
    }
    if (!Number.isInteger(this.ST1_COIN_EMA_FAST_PERIOD) || this.ST1_COIN_EMA_FAST_PERIOD < 2) {
      throw new Error('ST1_COIN_EMA_FAST_PERIOD must be an integer greater than 1');
    }
    if (!Number.isInteger(this.ST1_COIN_EMA_SLOW_PERIOD)
      || this.ST1_COIN_EMA_SLOW_PERIOD <= this.ST1_COIN_EMA_FAST_PERIOD) {
      throw new Error('ST1_COIN_EMA_SLOW_PERIOD must be greater than ST1_COIN_EMA_FAST_PERIOD');
    }
    if (!Number.isInteger(this.ST1_COIN_SUPERTREND_PERIOD) || this.ST1_COIN_SUPERTREND_PERIOD < 2) {
      throw new Error('ST1_COIN_SUPERTREND_PERIOD must be an integer greater than 1');
    }
    if (!Number.isFinite(this.ST1_COIN_SUPERTREND_MULTIPLIER) || this.ST1_COIN_SUPERTREND_MULTIPLIER <= 0) {
      throw new Error('ST1_COIN_SUPERTREND_MULTIPLIER must be greater than 0');
    }

    if (!Number.isInteger(this.FULL_ALIGNMENT_EMA_PERIOD) || this.FULL_ALIGNMENT_EMA_PERIOD < 2) {
      throw new Error('FULL_ALIGNMENT_EMA_PERIOD must be an integer greater than 1');
    }

    if (!Number.isFinite(this.FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER)
      || this.FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER < 0) {
      throw new Error('FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER must be 0 or greater');
    }

    if (this.LEVERAGE < 1 || this.LEVERAGE > 125) {
      throw new Error('LEVERAGE must be between 1 and 125');
    }

    if (this.POSITION_SIZE_PERCENT <= 0 || this.POSITION_SIZE_PERCENT > 100) {
      throw new Error('POSITION_SIZE_PERCENT must be between 0 and 100');
    }

    if (!Number.isInteger(this.ATR_PERIOD) || this.ATR_PERIOD <= 0) {
      throw new Error('ATR_PERIOD must be a positive integer');
    }

    if (this.BE_ATR_MULTIPLIER <= 0) {
      throw new Error('BE_ATR_MULTIPLIER must be greater than 0');
    }

    if (this.TRAILING_ACTIVATION_ATR_MULTIPLIER <= 0) {
      throw new Error('TRAILING_ACTIVATION_ATR_MULTIPLIER must be greater than 0');
    }

    if (this.TP_STEP_ATR_MULTIPLIER <= 0) {
      throw new Error('TP_STEP_ATR_MULTIPLIER must be greater than 0');
    }

    if (this.MIN_TP_STEP_PERCENT <= 0) {
      throw new Error('MIN_TP_STEP_PERCENT must be greater than 0');
    }

    if (!['LEGACY', 'STAGED_R_ATR'].includes(this.POSITION_FOLLOW_MODE)) {
      throw new Error('POSITION_FOLLOW_MODE must be LEGACY or STAGED_R_ATR');
    }

    if (!Number.isInteger(this.PROTECTION_DELAY_MIN_MS) || this.PROTECTION_DELAY_MIN_MS < 0) {
      throw new Error('PROTECTION_DELAY_MIN_MS must be a non-negative integer');
    }
    if (!Number.isInteger(this.PROTECTION_DELAY_MAX_MS)
      || this.PROTECTION_DELAY_MAX_MS < this.PROTECTION_DELAY_MIN_MS) {
      throw new Error('PROTECTION_DELAY_MAX_MS must be an integer at least PROTECTION_DELAY_MIN_MS');
    }
    if (!this.STRUCTURAL_SL_INTERVAL) {
      throw new Error('STRUCTURAL_SL_INTERVAL must not be empty');
    }
    if (!Number.isInteger(this.STRUCTURAL_SL_LOOKBACK) || this.STRUCTURAL_SL_LOOKBACK <= 0) {
      throw new Error('STRUCTURAL_SL_LOOKBACK must be a positive integer');
    }
    for (const key of ['STRUCTURAL_SL_BUFFER_PERCENT', 'FIRST_PROFIT_LOCK_PERCENT',
      'MAX_INITIAL_STOP_PERCENT', 'PROFIT_LOCK_TRIGGER_PERCENT', 'PROFIT_LOCK_STOP_PERCENT']) {
      if (!Number.isFinite(this[key]) || this[key] <= 0 || this[key] >= 100) {
        throw new Error(`${key} must be greater than 0 and less than 100`);
      }
    }

    for (const key of ['STRUCTURAL_SL_ATR_BUFFER_MULTIPLIER',
      'DELAYED_TRAILING_INITIAL_ATR_MULTIPLIER', 'DELAYED_TRAILING_TIGHTEN_R_MULTIPLIER',
      'BREAK_EVEN_R_MULTIPLIER', 'BREAK_EVEN_MIN_ATR_MULTIPLIER',
      'TRAILING_ACTIVATION_R_MULTIPLIER', 'TRAILING_ATR_NORMAL_MULTIPLIER',
      'TRAILING_ATR_STRONG_TREND_MULTIPLIER', 'TRAILING_ATR_WEAK_TREND_MULTIPLIER',
      'PROFIT_LOCK_STAGE_1_TRIGGER_R', 'PROFIT_LOCK_STAGE_1_STOP_R',
      'PROFIT_LOCK_STAGE_2_TRIGGER_R', 'PROFIT_LOCK_STAGE_2_STOP_R',
      'STAGED_INITIAL_TP_R_MULTIPLIER']) {
      if (!Number.isFinite(this[key]) || this[key] <= 0) throw new Error(`${key} must be greater than 0`);
    }

    if (this.PROFIT_LOCK_STOP_PERCENT >= this.PROFIT_LOCK_TRIGGER_PERCENT) {
      throw new Error('PROFIT_LOCK_STOP_PERCENT must be less than PROFIT_LOCK_TRIGGER_PERCENT');
    }

    if (this.PROFIT_LOCK_STAGE_1_STOP_R >= this.PROFIT_LOCK_STAGE_1_TRIGGER_R) {
      throw new Error('PROFIT_LOCK_STAGE_1_STOP_R must be less than PROFIT_LOCK_STAGE_1_TRIGGER_R');
    }
    if (this.PROFIT_LOCK_STAGE_2_TRIGGER_R < this.PROFIT_LOCK_STAGE_1_TRIGGER_R) {
      throw new Error('PROFIT_LOCK_STAGE_2_TRIGGER_R must be at least PROFIT_LOCK_STAGE_1_TRIGGER_R');
    }
    if (this.PROFIT_LOCK_STAGE_2_STOP_R < this.PROFIT_LOCK_STAGE_1_STOP_R
      || this.PROFIT_LOCK_STAGE_2_STOP_R >= this.PROFIT_LOCK_STAGE_2_TRIGGER_R) {
      throw new Error('PROFIT_LOCK_STAGE_2_STOP_R must improve stage 1 and remain below its trigger');
    }

    if (!Number.isInteger(this.AMBUSH_REFRESH_INTERVAL_MINUTES) || this.AMBUSH_REFRESH_INTERVAL_MINUTES <= 0) {
      throw new Error('AMBUSH_REFRESH_INTERVAL_MINUTES must be a positive integer');
    }

    if (!Number.isInteger(this.STRATEGY_CANDLE_CLOSE_DELAY_MS) || this.STRATEGY_CANDLE_CLOSE_DELAY_MS < 0 || this.STRATEGY_CANDLE_CLOSE_DELAY_MS >= 60000) {
      throw new Error('STRATEGY_CANDLE_CLOSE_DELAY_MS must be an integer between 0 and 59999');
    }

    if (!Number.isInteger(this.POSITION_MONITOR_INTERVAL_MS) || this.POSITION_MONITOR_INTERVAL_MS < 1000) {
      throw new Error('POSITION_MONITOR_INTERVAL_MS must be an integer and >= 1000');
    }

    if (this.SIMILARITY_BTC_WEIGHT + this.SIMILARITY_ETH_WEIGHT !== 100) {
      throw new Error(`Similarity weights must sum to 100. Current: BTC=${this.SIMILARITY_BTC_WEIGHT}%, ETH=${this.SIMILARITY_ETH_WEIGHT}%`);
    }

    const metricWeightTotal = Object.values(this.SIMILARITY_WEIGHTS)
      .reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(metricWeightTotal - 1) > 1e-9) {
      throw new Error(`SIMILARITY_WEIGHT_* values must sum to 100. Current: ${metricWeightTotal * 100}`);
    }

    return true;
  }

  // Get API credentials based on mode
  getApiCredentials() {
    if (this.APP_MODE === 'testnet') {
      return {
        key: this.BINANCE_TESTNET_API_KEY,
        secret: this.BINANCE_TESTNET_API_SECRET
      };
    }
    return {
      key: this.BINANCE_API_KEY,
      secret: this.BINANCE_API_SECRET
    };
  }

  // Get Binance URL based on mode
  getBinanceUrl() {
    if (this.APP_MODE === 'testnet') {
      return this.BINANCE_TESTNET_BASE_URL || process.env.BINANCE_TESTNET_BASE_URL || 'https://testnet.binancefuture.com';
    }
    return this.BINANCE_LIVE_BASE_URL || process.env.BINANCE_LIVE_BASE_URL || 'https://fapi.binance.com';
  }
}

// Create singleton instance
const config = new Config();
config.validate();

export { Config, config };
export default config;
