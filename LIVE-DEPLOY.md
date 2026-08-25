# AGROS R40 Live Deploy

## Policy
- Max open positions: 15
- Max normal notional per position: 50 USDT
- Isolated margin enforced before every live opening order
- BTC 15m EMA50 > EMA200: LONG regime
- BTC 15m EMA50 < EMA200: SHORT regime
- EMA50/EMA200 gap <= 0.15%: transition lock, no new entry
- BTC trend uses up to 1000 closed 15m candles and SMA-seeded EMA warm-up
- Final, non-overridable gate: LONG requires BTC15 SuperTrend UP; SHORT requires DOWN
- Missing/contrary final-gate data fails closed
- Breadth UP/DOWN confirmation uses 60/55 hysteresis; neutral/opposed breadth reduces risk budget
- Risk sizing may open below 50 USDT; 50 USDT is a hard notional cap
- Stop replacement no-op / already-crossed stops do not emit false update notifications
- LIVE accounting uses Binance account/userTrades truth where available and persists bot accounting state

## .env
Keep only secrets in `.env` (copy `.env.example` and fill values). Never put strategy settings there.

## AWS deployment
From the AWS app directory, stop the process first, back up the current app and `.env`, then replace code with this package while preserving `.env` and data.
Run `npm install`/`npm ci`, `npm test`, and only if tests pass restart PM2 with `--update-env`.
