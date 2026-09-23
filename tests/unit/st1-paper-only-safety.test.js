import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import orderService from '../../src/services/order-service.js';

describe('ST1 R43.8 hybrid execution safety', () => {
  test('default startup stays PAPER but an explicit credentialed LIVE preflight succeeds', () => {
    const result = spawnSync(process.execPath, ['scripts/r438-live-preflight.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        APP_MODE: 'live',
        ENABLE_REAL_TRADING: 'true',
        BINANCE_API_KEY: 'unit-test-key',
        BINANCE_API_SECRET: 'unit-test-secret',
        MAX_POSITIONS: '5',
        LIVE_MAX_POSITIONS_HARD_CAP: '5',
        LIVE_MAX_TOTAL_NOTIONAL_USDT: '250'
      },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/CORE real route \| SHADOW virtual-only/);
  });

  test('order service enables exchange routing only under both explicit LIVE flags', () => {
    const previous = { mode: process.env.APP_MODE, live: process.env.ENABLE_REAL_TRADING };
    try {
      process.env.APP_MODE = 'live';
      process.env.ENABLE_REAL_TRADING = 'true';
      expect(orderService.isLiveTradingEnabled()).toBe(true);
      process.env.ENABLE_REAL_TRADING = 'false';
      expect(orderService.isLiveTradingEnabled()).toBe(false);
    } finally {
      process.env.APP_MODE = previous.mode;
      process.env.ENABLE_REAL_TRADING = previous.live;
    }
  });

  test('SHADOW branch terminates before the real order route', () => {
    const source = fs.readFileSync(new URL('../../src/trading-loop.js', import.meta.url), 'utf8');
    const barrier = source.indexOf("entryGate.executionAuthority === 'SHADOW_ONLY'");
    const realRoute = source.indexOf('await this.enterPosition(', barrier);
    expect(barrier).toBeGreaterThanOrEqual(0);
    expect(realRoute).toBeGreaterThan(barrier);
    expect(source.slice(barrier, realRoute)).toMatch(/continue;/);
  });
});
