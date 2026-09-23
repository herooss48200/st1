import assert from 'node:assert/strict';
import fs from 'node:fs';
import AGROS_POLICY from '../src/config/agros-policy.js';
import config from '../src/config/config.js';
import { evaluateSt1R433EntryGate } from '../src/engines/st1-r433-entry-gate.js';

const live = String(process.env.APP_MODE || '').toLowerCase() === 'live';
const enabled = String(process.env.ENABLE_REAL_TRADING || '').toLowerCase() === 'true';
assert.ok(live && enabled, 'LIVE preflight requires APP_MODE=live and ENABLE_REAL_TRADING=true');
assert.equal(AGROS_POLICY.ST1_PAPER_ONLY, 'false', 'central live lock is still enabled');
assert.equal(AGROS_POLICY.APP_VERSION, 'ST1-R43.8-LIVE-CORE-PLUS-SHADOW');
assert.ok(process.env.BINANCE_API_KEY || config.BINANCE_API_KEY, 'BINANCE_API_KEY is missing');
assert.ok(process.env.BINANCE_API_SECRET || config.BINANCE_API_SECRET, 'BINANCE_API_SECRET is missing');

const core = evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 29, takerBuyRatio: 0.64 });
assert.deepEqual(
  { allowed: core.allowed, lane: core.lane, authority: core.executionAuthority },
  { allowed: true, lane: 'R433_CORE', authority: 'CORE_ORDER_ROUTE' }
);
const shadow = evaluateSt1R433EntryGate(
  { signal: 'BUY', rsi: 26.5, takerBuyRatio: 0.64 },
  { additiveShadowEnabled: true }
);
assert.deepEqual(
  { allowed: shadow.allowed, lane: shadow.lane, authority: shadow.executionAuthority },
  { allowed: true, lane: 'R438_SHADOW', authority: 'SHADOW_ONLY' }
);
assert.equal(evaluateSt1R433EntryGate({ signal: 'SELL', rsi: 71, takerBuyRatio: 0.4 }).allowed, false);

const tradeSize = Number(process.env.TRADE_SIZE_USDT || AGROS_POLICY.TRADE_SIZE_USDT);
const positionCap = Number(process.env.MAX_POSITIONS || AGROS_POLICY.MAX_POSITIONS);
const totalNotionalCap = Number(process.env.LIVE_MAX_TOTAL_NOTIONAL_USDT || AGROS_POLICY.LIVE_MAX_TOTAL_NOTIONAL_USDT);
assert.ok(tradeSize > 0 && tradeSize <= 50, 'TRADE_SIZE_USDT must be in (0, 50]');
assert.ok(positionCap > 0 && positionCap <= 25, 'MAX_POSITIONS must be in (0, 25]');
assert.ok(totalNotionalCap > 0 && totalNotionalCap <= 1250, 'LIVE_MAX_TOTAL_NOTIONAL_USDT must be in (0, 1250]');

const loopSource = fs.readFileSync(new URL('../src/trading-loop.js', import.meta.url), 'utf8');
const shadowBarrier = loopSource.indexOf("entryGate.executionAuthority === 'SHADOW_ONLY'");
const realRoute = loopSource.indexOf('await this.enterPosition(', shadowBarrier);
assert.ok(shadowBarrier >= 0 && realRoute > shadowBarrier, 'SHADOW routing barrier is missing before real order route');
assert.match(loopSource.slice(shadowBarrier, realRoute), /continue;/, 'SHADOW branch does not terminate before real order route');

console.log(`✅ ${AGROS_POLICY.APP_VERSION} preflight passed | CORE real route | SHADOW virtual-only | SHORT closed`);
