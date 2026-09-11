// Keep tests deterministic and isolated from developer or production .env files.
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'paper';
process.env.ENABLE_REAL_TRADING = 'false';
// Production remains hard PAPER-only. Legacy LIVE-path unit tests may exercise
// their isolated mocks without weakening the runtime safety lock.
process.env.ST1_ALLOW_LIVE_TESTS = 'true';
process.env.BINANCE_API_KEY = 'test-api-key';
process.env.BINANCE_API_SECRET = 'test-api-secret';
process.env.ENABLE_TELEGRAM = 'false';
process.env.MARKET_BREADTH_MODE = 'WEIGHTED_TREND';
process.env.MARKET_TREND_BTC_WEIGHT = '50';
process.env.MARKET_TREND_ETH_WEIGHT = '25';
process.env.MARKET_TREND_BREADTH_WEIGHT = '25';
