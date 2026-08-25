import { Config, config } from '../../src/config/config.js';

describe('Config System', () => {
  test('should load configuration from environment', () => {
    expect(config).toBeDefined();
    expect(config.APP_MODE).toBeDefined();
  });

  test('should provide typed getters', () => {
    const mode = config.APP_MODE;
    expect(['paper', 'testnet', 'live']).toContain(mode);
  });

  test('defaults similarity and full-alignment EMA controls to the approved strategy values', () => {
    expect(config.SIMILARITY_THRESHOLD).toBe(52);
    expect(config.MARKET_BREADTH_TOP_COINS).toBe(200);
    expect(config.MARKET_BREADTH_CANDIDATE_MULTIPLIER).toBe(2);
    expect(config.FULL_ALIGNMENT_EMA_READY_ENABLED).toBe(true);
    expect(config.FULL_ALIGNMENT_EMA_PERIOD).toBe(50);
    expect(config.FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER).toBeCloseTo(0.10, 10);
  });

  test('should validate required configuration', () => {
    expect(config.validate()).toBe(true);
  });

  test('should provide Binance API URL based on mode', () => {
    const originalMode = process.env.APP_MODE;
    const originalRealTrading = process.env.ENABLE_REAL_TRADING;

    try {
      process.env.APP_MODE = 'paper';
      process.env.ENABLE_REAL_TRADING = 'false';
      expect(new Config().BINANCE_URL).toBe('https://fapi.binance.com');

      process.env.APP_MODE = 'testnet';
      expect(new Config().BINANCE_URL).toBe('https://testnet.binancefuture.com');

      process.env.APP_MODE = 'live';
      process.env.ENABLE_REAL_TRADING = 'true';
      expect(new Config().BINANCE_URL).toBe('https://fapi.binance.com');
    } finally {
      process.env.APP_MODE = originalMode;
      process.env.ENABLE_REAL_TRADING = originalRealTrading;
    }
  });

  test('should throw when similarity weights do not sum to 100', () => {
    const originalBtcWeight = process.env.SIMILARITY_BTC_WEIGHT;
    const originalEthWeight = process.env.SIMILARITY_ETH_WEIGHT;

    try {
      process.env.SIMILARITY_BTC_WEIGHT = '90';
      process.env.SIMILARITY_ETH_WEIGHT = '20';

      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/Similarity weights must sum to 100/);
    } finally {
      process.env.SIMILARITY_BTC_WEIGHT = originalBtcWeight;
      process.env.SIMILARITY_ETH_WEIGHT = originalEthWeight;
    }
  });

  test('should load ATR runtime tuning values from config', () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;
    const originalTpStepAtrMultiplier = process.env.TP_STEP_ATR_MULTIPLIER;
    const originalMinTpStepPercent = process.env.MIN_TP_STEP_PERCENT;

    try {
      process.env.ATR_PERIOD = '21';
      process.env.BE_ATR_MULTIPLIER = '1.25';
      process.env.TP_STEP_ATR_MULTIPLIER = '0.8';
      process.env.MIN_TP_STEP_PERCENT = '0.6';

      const cfg = new Config();
      expect(cfg.ATR_PERIOD).toBe(21);
      expect(cfg.BE_ATR_MULTIPLIER).toBeCloseTo(1.25, 10);
      expect(cfg.TP_STEP_ATR_MULTIPLIER).toBeCloseTo(0.8, 10);
      expect(cfg.MIN_TP_STEP_PERCENT).toBeCloseTo(0.6, 10);
    } finally {
      process.env.ATR_PERIOD = originalAtrPeriod;
      process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
      process.env.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
      process.env.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    }
  });

  test('should throw on invalid ATR runtime tuning values', () => {
    const originalAtrPeriod = process.env.ATR_PERIOD;
    const originalBeAtrMultiplier = process.env.BE_ATR_MULTIPLIER;
    const originalTpStepAtrMultiplier = process.env.TP_STEP_ATR_MULTIPLIER;
    const originalMinTpStepPercent = process.env.MIN_TP_STEP_PERCENT;

    try {
      process.env.ATR_PERIOD = '0';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/ATR_PERIOD must be a positive integer/);

      process.env.ATR_PERIOD = '14';
      process.env.BE_ATR_MULTIPLIER = '0';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/BE_ATR_MULTIPLIER must be greater than 0/);

      process.env.BE_ATR_MULTIPLIER = '1';
      process.env.TP_STEP_ATR_MULTIPLIER = '-1';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/TP_STEP_ATR_MULTIPLIER must be greater than 0/);

      process.env.TP_STEP_ATR_MULTIPLIER = '0.5';
      process.env.MIN_TP_STEP_PERCENT = '0';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/MIN_TP_STEP_PERCENT must be greater than 0/);
    } finally {
      process.env.ATR_PERIOD = originalAtrPeriod;
      process.env.BE_ATR_MULTIPLIER = originalBeAtrMultiplier;
      process.env.TP_STEP_ATR_MULTIPLIER = originalTpStepAtrMultiplier;
      process.env.MIN_TP_STEP_PERCENT = originalMinTpStepPercent;
    }
  });

  test('should load and validate ambush refresh interval from config', () => {
    const originalRefreshMinutes = process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;

    try {
      process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = '45';
      const cfg = new Config();
      expect(cfg.AMBUSH_REFRESH_INTERVAL_MINUTES).toBe(45);
      expect(cfg.validate()).toBe(true);
    } finally {
      process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = originalRefreshMinutes;
    }
  });

  test('should throw on invalid ambush refresh interval', () => {
    const originalRefreshMinutes = process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;

    try {
      process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = '0';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/AMBUSH_REFRESH_INTERVAL_MINUTES must be a positive integer/);
    } finally {
      process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = originalRefreshMinutes;
    }
  });

  test('should default POSITION_MONITOR_INTERVAL_MS to 5000', () => {
    const original = process.env.POSITION_MONITOR_INTERVAL_MS;

    try {
      delete process.env.POSITION_MONITOR_INTERVAL_MS;
      const cfg = new Config();
      expect(cfg.POSITION_MONITOR_INTERVAL_MS).toBe(5000);
      expect(cfg.validate()).toBe(true);
    } finally {
      process.env.POSITION_MONITOR_INTERVAL_MS = original;
    }
  });

  test('should throw on invalid POSITION_MONITOR_INTERVAL_MS', () => {
    const original = process.env.POSITION_MONITOR_INTERVAL_MS;

    try {
      process.env.POSITION_MONITOR_INTERVAL_MS = '0';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/POSITION_MONITOR_INTERVAL_MS must be an integer and >= 1000/);

      process.env.POSITION_MONITOR_INTERVAL_MS = '500';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/POSITION_MONITOR_INTERVAL_MS must be an integer and >= 1000/);
    } finally {
      process.env.POSITION_MONITOR_INTERVAL_MS = original;
    }
  });
});


describe('Closed-candle schedule defaults', () => {
  test('defaults ambush refresh to 15 minutes and close delay to 5 seconds', () => {
    const originalRefresh = process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;
    const originalDelay = process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS;
    const originalMonitor = process.env.POSITION_MONITOR_INTERVAL_MS;

    try {
      delete process.env.AMBUSH_REFRESH_INTERVAL_MINUTES;
      delete process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS;
      delete process.env.POSITION_MONITOR_INTERVAL_MS;
      const cfg = new Config();

      expect(cfg.AMBUSH_REFRESH_INTERVAL_MINUTES).toBe(15);
      expect(cfg.STRATEGY_CANDLE_CLOSE_DELAY_MS).toBe(5000);
      expect(cfg.POSITION_MONITOR_INTERVAL_MS).toBe(5000);
      expect(cfg.validate()).toBe(true);
    } finally {
      process.env.AMBUSH_REFRESH_INTERVAL_MINUTES = originalRefresh;
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = originalDelay;
      process.env.POSITION_MONITOR_INTERVAL_MS = originalMonitor;
    }
  });

  test('rejects an invalid strategy candle close delay', () => {
    const originalDelay = process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS;

    try {
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = '60000';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/STRATEGY_CANDLE_CLOSE_DELAY_MS/);
    } finally {
      process.env.STRATEGY_CANDLE_CLOSE_DELAY_MS = originalDelay;
    }
  });
});

describe('Delayed structural protection defaults', () => {
  test('uses a one-time 1-4 minute delay, 20 closed 15m candles and 0.1%/0.5% thresholds', () => {
    const cfg = new Config();

    expect(cfg.DELAYED_PROTECTION_ENABLED).toBe(true);
    expect(cfg.PROTECTION_DELAY_MIN_MS).toBe(60000);
    expect(cfg.PROTECTION_DELAY_MAX_MS).toBe(240000);
    expect(cfg.STRUCTURAL_SL_INTERVAL).toBe('15m');
    expect(cfg.STRUCTURAL_SL_LOOKBACK).toBe(20);
    expect(cfg.STRUCTURAL_SL_BUFFER_PERCENT).toBe(0.1);
    expect(cfg.FIRST_PROFIT_LOCK_PERCENT).toBe(0.5);
    expect(cfg.validate()).toBe(true);
  });

  test('rejects a maximum protection delay below the minimum', () => {
    const originalMin = process.env.PROTECTION_DELAY_MIN_MS;
    const originalMax = process.env.PROTECTION_DELAY_MAX_MS;
    try {
      process.env.PROTECTION_DELAY_MIN_MS = '240000';
      process.env.PROTECTION_DELAY_MAX_MS = '60000';
      expect(() => {
        const cfg = new Config();
        cfg.validate();
      }).toThrow(/PROTECTION_DELAY_MAX_MS/);
    } finally {
      process.env.PROTECTION_DELAY_MIN_MS = originalMin;
      process.env.PROTECTION_DELAY_MAX_MS = originalMax;
    }
  });
  test('paper mode is hard-locked against real trading and does not require Binance secrets', () => {
    const previous = {
      mode: process.env.APP_MODE,
      live: process.env.ENABLE_REAL_TRADING,
      key: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET
    };
    try {
      process.env.APP_MODE = 'paper';
      process.env.ENABLE_REAL_TRADING = 'false';
      delete process.env.BINANCE_API_KEY;
      delete process.env.BINANCE_API_SECRET;
      const paperConfig = new Config();
      expect(paperConfig.APP_MODE).toBe('paper');
      expect(paperConfig.ENABLE_REAL_TRADING).toBe(false);

      process.env.ENABLE_REAL_TRADING = 'true';
      expect(() => new Config()).toThrow(/PAPER mode cannot enable real trading/);
    } finally {
      process.env.APP_MODE = previous.mode;
      process.env.ENABLE_REAL_TRADING = previous.live;
      process.env.BINANCE_API_KEY = previous.key;
      process.env.BINANCE_API_SECRET = previous.secret;
    }
  });

  test('live mode still requires Binance credentials', () => {
    const previous = {
      mode: process.env.APP_MODE,
      live: process.env.ENABLE_REAL_TRADING,
      key: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET
    };
    try {
      process.env.APP_MODE = 'live';
      process.env.ENABLE_REAL_TRADING = 'true';
      delete process.env.BINANCE_API_KEY;
      delete process.env.BINANCE_API_SECRET;
      expect(() => new Config()).toThrow(/BINANCE_API_KEY/);
    } finally {
      process.env.APP_MODE = previous.mode;
      process.env.ENABLE_REAL_TRADING = previous.live;
      process.env.BINANCE_API_KEY = previous.key;
      process.env.BINANCE_API_SECRET = previous.secret;
    }
  });

});
