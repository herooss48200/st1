import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { St1R438ShadowPortfolio } from '../../src/research/st1-r438-shadow-portfolio.js';

describe('ST1 R43.8 virtual-only shadow portfolio', () => {
  let directory;
  let storageFile;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st1-r438-shadow-'));
    storageFile = path.join(directory, 'state.json');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  test('opens only a SHADOW_ONLY record and persists it', () => {
    const portfolio = new St1R438ShadowPortfolio({ storageFile });
    const opened = portfolio.open({ symbol: 'BTCUSDT', entryPrice: 100, enteredAt: 1 });
    expect(opened).toMatchObject({ opened: true, position: { executionAuthority: 'SHADOW_ONLY' } });
    expect(new St1R438ShadowPortfolio({ storageFile }).getOpen()).toHaveLength(1);
  });

  test('activates the profit lock and closes through virtual trailing accounting', () => {
    const portfolio = new St1R438ShadowPortfolio({ storageFile, notionalUsdt: 50 });
    portfolio.open({ symbol: 'BTCUSDT', entryPrice: 100, enteredAt: 1 });
    const locked = portfolio.update('BTCUSDT', 101, { now: 2, atrValue: 0.1 });
    expect(locked.position.lockActivated).toBe(true);
    const closed = portfolio.update('BTCUSDT', 100.7, { now: 3, atrValue: 0.1 });
    expect(closed).toMatchObject({ closed: true, result: { exitReason: 'SHADOW_TRAILING' } });
    expect(closed.result.netPnlUsdt).toBeGreaterThan(0);
  });

  test('closes a losing observation at the virtual stop without an exchange order', () => {
    const portfolio = new St1R438ShadowPortfolio({ storageFile, notionalUsdt: 50 });
    portfolio.open({ symbol: 'ETHUSDT', entryPrice: 100, enteredAt: 1 });
    const closed = portfolio.update('ETHUSDT', 98.5, { now: 2 });
    expect(closed).toMatchObject({
      closed: true,
      result: { executionAuthority: 'SHADOW_ONLY', exitReason: 'SHADOW_SL' }
    });
    expect(closed.result.netPnlUsdt).toBeLessThan(0);
  });
});
