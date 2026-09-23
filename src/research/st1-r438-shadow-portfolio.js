import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const round = (value, digits = 8) => Number(Number(value).toFixed(digits));

export class St1R438ShadowPortfolio {
  constructor({
    storageFile = 'data/st1-r438-shadow-state.json',
    notionalUsdt = 50,
    stopPercent = 1.5,
    lockPercent = 0.5,
    maximumHoldMinutes = 1440,
    commissionPercent = 0.08
  } = {}) {
    this.storageFile = path.resolve(process.cwd(), storageFile);
    this.notionalUsdt = Number(notionalUsdt);
    this.stopPercent = Number(stopPercent);
    this.lockPercent = Number(lockPercent);
    this.maximumHoldMinutes = Number(maximumHoldMinutes);
    this.commissionPercent = Number(commissionPercent);
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.storageFile)) return { schemaVersion: 1, open: {}, closed: [] };
      const parsed = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
      return {
        schemaVersion: 1,
        open: parsed?.open && typeof parsed.open === 'object' ? parsed.open : {},
        closed: Array.isArray(parsed?.closed) ? parsed.closed : []
      };
    } catch {
      return { schemaVersion: 1, open: {}, closed: [] };
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
    const temporary = `${this.storageFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporary, this.storageFile);
  }

  open({ symbol, entryPrice, enteredAt = Date.now(), features = {} } = {}) {
    const normalized = String(symbol || '').toUpperCase();
    const price = Number(entryPrice);
    if (!normalized || !(price > 0)) return { opened: false, reason: 'INVALID_INPUT' };
    if (this.state.open[normalized]) return { opened: false, reason: 'ALREADY_OPEN' };
    const position = {
      id: randomUUID(), symbol: normalized, side: 'BUY', executionAuthority: 'SHADOW_ONLY',
      entryPrice: price, enteredAt, notionalUsdt: this.notionalUsdt,
      stopPrice: price * (1 - this.stopPercent / 100),
      lockTriggerPrice: price * (1 + this.lockPercent / 100),
      highestPrice: price, maximumFavorableExcursionPercent: 0,
      maximumAdverseExcursionPercent: 0, lockActivated: false, features
    };
    this.state.open[normalized] = position;
    this.persist();
    return { opened: true, position };
  }

  update(symbol, currentPrice, { now = Date.now(), atrValue = null } = {}) {
    const normalized = String(symbol || '').toUpperCase();
    const position = this.state.open[normalized];
    const price = Number(currentPrice);
    if (!position || !(price > 0)) return { changed: false, closed: false };
    position.highestPrice = Math.max(Number(position.highestPrice), price);
    position.maximumFavorableExcursionPercent = Math.max(
      Number(position.maximumFavorableExcursionPercent),
      ((price - position.entryPrice) / position.entryPrice) * 100
    );
    position.maximumAdverseExcursionPercent = Math.min(
      Number(position.maximumAdverseExcursionPercent),
      ((price - position.entryPrice) / position.entryPrice) * 100
    );
    if (!position.lockActivated && price >= position.lockTriggerPrice) {
      position.lockActivated = true;
      position.lockActivatedAt = now;
      position.stopPrice = Math.max(position.stopPrice, position.lockTriggerPrice);
    }
    const atr = Number(atrValue);
    if (position.lockActivated && atr > 0) {
      position.stopPrice = Math.max(position.stopPrice, position.highestPrice - atr * 2.5);
    }
    const expired = now - Number(position.enteredAt) >= this.maximumHoldMinutes * 60_000;
    const stopped = price <= Number(position.stopPrice);
    if (!stopped && !expired) {
      position.lastPrice = price;
      position.lastObservedAt = now;
      this.persist();
      return { changed: true, closed: false, position };
    }
    const exitPrice = stopped ? Math.min(price, Number(position.stopPrice)) : price;
    const grossReturnPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    const netPnlUsdt = this.notionalUsdt * ((grossReturnPercent - this.commissionPercent) / 100);
    const result = {
      ...position, exitPrice, exitedAt: now,
      exitReason: stopped ? (position.lockActivated ? 'SHADOW_TRAILING' : 'SHADOW_SL') : 'SHADOW_TIME_LIMIT',
      grossReturnPercent: round(grossReturnPercent),
      netPnlUsdt: round(netPnlUsdt)
    };
    delete this.state.open[normalized];
    this.state.closed.push(result);
    this.state.closed = this.state.closed.slice(-5000);
    this.persist();
    return { changed: true, closed: true, result };
  }

  getOpen() { return Object.values(this.state.open); }
  getClosed() { return [...this.state.closed]; }
}

export default St1R438ShadowPortfolio;
