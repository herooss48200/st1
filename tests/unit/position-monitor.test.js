import PositionMonitor from '../../src/services/position-monitor.js';
import { jest } from '@jest/globals';

describe('PositionMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('start is idempotent and schedules cycles', async () => {
    const tradingLoop = {
      runIndependentPositionMonitorCycle: jest.fn().mockResolvedValue(undefined)
    };

    const monitor = new PositionMonitor({ tradingLoop, intervalMs: 100 });

    monitor.start();
    monitor.start();

    await jest.advanceTimersByTimeAsync(0);
    expect(tradingLoop.runIndependentPositionMonitorCycle).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(100);
    expect(tradingLoop.runIndependentPositionMonitorCycle).toHaveBeenCalledTimes(2);
  });

  test('executeCycle prevents overlap when already running', async () => {
    let resolveCycle;
    const tradingLoop = {
      runIndependentPositionMonitorCycle: jest.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveCycle = resolve;
        })
      )
    };

    const monitor = new PositionMonitor({ tradingLoop, intervalMs: 100 });

    const first = monitor.executeCycle();
    const second = monitor.executeCycle();

    expect(tradingLoop.runIndependentPositionMonitorCycle).toHaveBeenCalledTimes(1);

    resolveCycle();
    await first;
    await second;
  });

  test('stop clears timer and waits for in-flight cycle', async () => {
    let resolveCycle;
    const tradingLoop = {
      runIndependentPositionMonitorCycle: jest.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveCycle = resolve;
        })
      )
    };

    const monitor = new PositionMonitor({ tradingLoop, intervalMs: 100 });
    monitor.start();

    await jest.advanceTimersByTimeAsync(0);
    expect(tradingLoop.runIndependentPositionMonitorCycle).toHaveBeenCalledTimes(1);

    const stopPromise = monitor.stop();
    resolveCycle();
    await stopPromise;

    expect(monitor.started).toBe(false);
    expect(monitor.timer).toBeNull();
  });

  test('cycle failure does not stop future cycles', async () => {
    const tradingLoop = {
      runIndependentPositionMonitorCycle: jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined)
    };

    const monitor = new PositionMonitor({ tradingLoop, intervalMs: 100 });
    monitor.start();

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(100);

    expect(tradingLoop.runIndependentPositionMonitorCycle).toHaveBeenCalledTimes(2);
  });

  test('position monitor continues while an unrelated heavy scan is pending', async () => {
    let finishHeavyScan;
    const heavyScan = new Promise((resolve) => { finishHeavyScan = resolve; });
    const tradingLoop = {
      runIndependentPositionMonitorCycle: jest.fn().mockResolvedValue(undefined)
    };
    const monitor = new PositionMonitor({ tradingLoop, intervalMs: 100 });
    monitor.start();

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300);

    expect(tradingLoop.runIndependentPositionMonitorCycle).toHaveBeenCalledTimes(4);
    finishHeavyScan();
    await heavyScan;
    await monitor.stop();
  });
});
