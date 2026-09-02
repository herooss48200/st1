import config from '../src/config/config.js';
import orderService from '../src/services/order-service.js';

const fail = (message) => {
  throw new Error(`R41.5 LIVE PREFLIGHT FAILED: ${message}`);
};

if (config.APP_MODE !== 'live' || config.ENABLE_REAL_TRADING !== true) fail('live flags are not explicit');
if (config.PAPER_UNLIMITED_POSITIONS !== false) fail('PAPER_UNLIMITED_POSITIONS must be false');
if (config.APP_VERSION !== 'ST1-R41.5-LIVE-25X50-10X') fail(`unexpected version ${config.APP_VERSION}`);
if (config.LEVERAGE !== 10) fail(`leverage must be 10, received ${config.LEVERAGE}`);
if (config.MAX_POSITIONS !== 25 || config.LIVE_MAX_POSITIONS_HARD_CAP !== 25) fail('position cap must be 25');
if (config.TRADE_SIZE_USDT !== 50 || config.LIVE_MAX_TRADE_SIZE_USDT !== 50) fail('trade size cap must be 50 USDT');
if (config.LIVE_MAX_TOTAL_NOTIONAL_USDT !== 1250) fail('total notional cap must be 1250 USDT');
if (config.ST1_RESCUE_RADAR_LIVE_CLOSE_ENABLED !== true) fail('LIVE Rescue Radar close is disabled');

const [account, positions, orders] = await Promise.all([
  orderService.getFuturesAccountSnapshot(),
  orderService.getOpenPositions(),
  orderService.getOpenOrders()
]);

const walletBalance = Number(account?.walletBalance);
const availableBalance = Number(account?.availableBalance);
if (!Number.isFinite(walletBalance) || !Number.isFinite(availableBalance)) fail('account balances are unavailable');
if (availableBalance < config.LIVE_START_MIN_AVAILABLE_BALANCE_USDT) {
  fail(`available balance ${availableBalance} is below ${config.LIVE_START_MIN_AVAILABLE_BALANCE_USDT} USDT`);
}
if (positions.length !== 0) fail(`${positions.length} existing Futures position(s) must be reviewed first`);
if (orders.length !== 0) fail(`${orders.length} existing Futures order(s) must be reviewed first`);

console.log(JSON.stringify({
  ok: true,
  appVersion: config.APP_VERSION,
  mode: config.APP_MODE,
  walletBalance,
  availableBalance,
  leverage: config.LEVERAGE,
  maxPositions: config.LIVE_MAX_POSITIONS_HARD_CAP,
  maxTradeNotionalUsdt: config.LIVE_MAX_TRADE_SIZE_USDT,
  maxTotalNotionalUsdt: config.LIVE_MAX_TOTAL_NOTIONAL_USDT,
  reservedFreeBalanceUsdt: config.LIVE_MIN_FREE_BALANCE_USDT,
  openPositions: positions.length,
  openOrders: orders.length
}, null, 2));

