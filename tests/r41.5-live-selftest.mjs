import assert from 'node:assert/strict';
import fs from 'node:fs';
import AGROS_POLICY from '../src/config/agros-policy.js';

assert.equal(AGROS_POLICY.APP_MODE, 'paper');
assert.equal(AGROS_POLICY.ENABLE_REAL_TRADING, 'false');
assert.equal(AGROS_POLICY.ST1_PAPER_ONLY, 'true');
assert.equal(AGROS_POLICY.APP_VERSION, 'ST1-R43.1-PAPER-RENKO-SCAN-REPORT');
assert.equal(AGROS_POLICY.LEVERAGE, '10');
assert.equal(AGROS_POLICY.MAX_POSITIONS, '25');
assert.equal(AGROS_POLICY.LIVE_MAX_POSITIONS_HARD_CAP, '25');
assert.equal(AGROS_POLICY.TRADE_SIZE_USDT, '50');
assert.equal(AGROS_POLICY.LIVE_MAX_TRADE_SIZE_USDT, '50');
assert.equal(AGROS_POLICY.LIVE_MAX_TOTAL_NOTIONAL_USDT, '1250');
assert.equal(AGROS_POLICY.LIVE_MIN_FREE_BALANCE_USDT, '10');
assert.equal(AGROS_POLICY.LIVE_START_MIN_AVAILABLE_BALANCE_USDT, '130');
assert.equal(AGROS_POLICY.ST1_RESCUE_RADAR_ENABLED, 'false');
assert.equal(AGROS_POLICY.ST1_RESCUE_RADAR_PAPER_CLOSE_ENABLED, 'false');
assert.equal(AGROS_POLICY.ST1_RESCUE_RADAR_LIVE_CLOSE_ENABLED, 'false');
assert.equal(AGROS_POLICY.ST1_ORDERFLOW_LONG_MIN_BUY_RATIO, '0.58');
assert.equal(AGROS_POLICY.ST1_ORDERFLOW_SHORT_MAX_BUY_RATIO, '0.42');
assert.equal(AGROS_POLICY.ST1_ORDERFLOW_REQUIRED_CONFIRMATIONS, '2');

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(packageJson.scripts.paper, /APP_MODE=paper/);
assert.match(packageJson.scripts.paper, /ENABLE_REAL_TRADING=false/);
assert.match(packageJson.scripts.live, /paper-only-guard/);
assert.doesNotMatch(packageJson.scripts.live, /ENABLE_REAL_TRADING=true/);

const orderSource = fs.readFileSync(new URL('../src/services/order-service.js', import.meta.url), 'utf8');
assert.match(orderSource, /LIVE_TOTAL_NOTIONAL_HARD_CAP/);
assert.match(orderSource, /LIVE_AVAILABLE_BALANCE_HARD_FLOOR/);
assert.match(orderSource, /config\.ST1_PAPER_ONLY === true/);

const loopSource = fs.readFileSync(new URL('../src/trading-loop.js', import.meta.url), 'utf8');
assert.match(loopSource, /LIVE_START_POSITION_CAP_EXCEEDED/);
assert.match(loopSource, /throw error;\s*\n\s*}\s*\n\s*}\s*\n\s*async fetchLiveOpenPositions/);
assert.match(loopSource, /schema: 2/);
assert.match(loopSource, /riskTradeHistory: this\.riskTradeHistory\.slice\(0, 5000\)/);

console.log('✅ R43.1 PAPER-only self-test passed | real Renko scan report + rejection counts | LIVE locked');
