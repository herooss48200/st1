import { spawnSync } from 'node:child_process';
import orderService from '../../src/services/order-service.js';

describe('ST1 R43.1 PAPER-only safety lock', () => {
  test('production startup rejects explicit LIVE flags before the bot can start', () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', "import './src/config/config.js'"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          APP_MODE: 'live',
          ENABLE_REAL_TRADING: 'true',
          ST1_ALLOW_LIVE_TESTS: 'false',
          BINANCE_API_KEY: 'unit-test-key',
          BINANCE_API_SECRET: 'unit-test-secret'
        },
        encoding: 'utf8'
      }
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/PAPER-ONLY safety lock/);
  });

  test('order service cannot report LIVE enabled under the production PAPER-only lock', () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      mode: process.env.APP_MODE,
      live: process.env.ENABLE_REAL_TRADING
    };

    try {
      process.env.NODE_ENV = 'production';
      process.env.APP_MODE = 'live';
      process.env.ENABLE_REAL_TRADING = 'true';
      expect(orderService.isLiveTradingEnabled()).toBe(false);
    } finally {
      process.env.NODE_ENV = previous.nodeEnv;
      process.env.APP_MODE = previous.mode;
      process.env.ENABLE_REAL_TRADING = previous.live;
    }
  });
});
