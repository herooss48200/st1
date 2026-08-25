import logger from './logger.js';

class PositionMonitor {
  constructor({ tradingLoop, intervalMs = 5000 }) {
    this.tradingLoop = tradingLoop;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.started = false;
    this.stopping = false;
    this.cycleInProgress = false;
    this.currentCyclePromise = null;
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopping = false;

    logger.info('Independent position monitor started', {
      intervalMs: this.intervalMs
    });

    this.scheduleNext(0);
  }

  scheduleNext(delayMs = this.intervalMs) {
    if (this.stopping) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.executeCycle();
    }, Math.max(0, Number(delayMs) || 0));
  }

  async executeCycle() {
    if (this.stopping) {
      return;
    }

    if (this.cycleInProgress) {
      this.scheduleNext(this.intervalMs);
      return;
    }

    this.cycleInProgress = true;
    this.currentCyclePromise = (async () => {
      try {
        await this.tradingLoop.runIndependentPositionMonitorCycle();
      } catch (error) {
        logger.error('Independent position monitor cycle failed', {
          error: error.message
        });
      }
    })();

    try {
      await this.currentCyclePromise;
    } finally {
      this.currentCyclePromise = null;
      this.cycleInProgress = false;
      if (!this.stopping) {
        this.scheduleNext(this.intervalMs);
      }
    }
  }

  async stop() {
    this.stopping = true;
    this.started = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.currentCyclePromise) {
      try {
        await this.currentCyclePromise;
      } catch {
        // Cycle errors are already logged in executeCycle.
      }
    }

    logger.info('Independent position monitor stopped');
  }
}

export { PositionMonitor };
export default PositionMonitor;