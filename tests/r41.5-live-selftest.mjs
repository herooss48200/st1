import assert from 'node:assert/strict';
import fs from 'node:fs';
import AGROS_POLICY from '../src/config/agros-policy.js';

assert.equal(AGROS_POLICY.APP_MODE, 'paper');
assert.equal(AGROS_POLICY.ENABLE_REAL_TRADING, 'false');
assert.equal(AGROS_POLICY.APP_VERSION, 'ST1-R41.5-LIVE-25X50-10X');
assert.equal(AGROS_POLICY.LEVERAGE, '10');
assert.equal(AGROS_POLICY.MAX_POSITIONS, '25');
assert.equal(AGROS_POLICY.LIVE_MAX_POSITIONS_HARD_CAP, '25');
assert.equal(AGROS_POLICY.TRADE_SIZE_USDT, '50');
assert.equal(AGROS_POLICY.LIVE_MAX_TRADE_SIZE_USDT, '50');
assert.equal(AGROS_POLICY.LIVE_MAX_TOTAL_NOTIONAL_USDT, '1250');
assert.equal(AGROS_POLICY.LIVE_MIN_FREE_BALANCE_USDT, '10');
assert.equal(AGROS_POLICY.LIVE_START_MIN_AVAILABLE_BALANCE_USDT, '130');
assert.equal(AGROS_POLICY.ST1_RESCUE_RADAR_LIVE_CLOSE_ENABLED, 'true');

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(packageJson.scripts.live, /APP_MODE=live/);
assert.match(packageJson.scripts.live, /ENABLE_REAL_TRADING=true/);
assert.match(packageJson.scripts.live, /PAPER_UNLIMITED_POSITIONS=false/);

const orderSource = fs.readFileSync(new URL('../src/services/order-service.js', import.meta.url), 'utf8');
assert.match(orderSource, /LIVE_TOTAL_NOTIONAL_HARD_CAP/);
assert.match(orderSource, /LIVE_AVAILABLE_BALANCE_HARD_FLOOR/);

const loopSource = fs.readFileSync(new URL('../src/trading-loop.js', import.meta.url), 'utf8');
assert.match(loopSource, /LIVE_START_POSITION_CAP_EXCEEDED/);
assert.match(loopSource, /throw error;\s*\n\s*}\s*\n\s*}\s*\n\s*async fetchLiveOpenPositions/);
assert.match(loopSource, /schema: 2/);
assert.match(loopSource, /riskTradeHistory: this\.riskTradeHistory\.slice\(0, 5000\)/);

console.log('✅ R41.5 LIVE self-test passed | 25×50 USDT | 10x ISOLATED | 1250 USDT total cap | fail-closed preflight');
