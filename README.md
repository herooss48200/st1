# ST1 — Binance Futures PAPER Strategy

ST1 is the separate Node.js strategy project for Binance USDT-M Futures. This build is intentionally PAPER-first. Its entry contract is: 15m Bollinger setup candle → opposite-color closed confirmation → W1/W2/W3 live break of the setup candle solid body → coin EMA50/EMA200 → coin SuperTrend → BTC regime → strict final BTC15 SuperTrend.

Position follow-up defaults to `STAGED_R_ATR`: entry-to-stop distance is recorded as 1R, commission-adjusted break-even requires both the configured R and ATR thresholds, and trailing starts at 1.5R. The Chandelier stop uses the true highest/lowest observed price since entry. Its distance is 2.25 ATR for aligned BTC/ETH trends, 1.75 ATR normally, and 1.25 ATR when they diverge. The former moving take-profit behavior remains available only through `POSITION_FOLLOW_MODE=LEGACY`.

> Trading software carries financial risk. Validate changes in paper and testnet modes before considering live operation.

## Current architecture

Bootstrap currently initializes six services and six engines.

- Services: market data, candle data, indicators, orders, notifications, and historical candle cache.
- Engines: similarity, trend, trigger, sniper, position management, and risk management.
- Background components: trading loop, position monitor, diagnostics, and the HTTP health server.

### Strategy defaults

- Similarity reference: BTC 85% + ETH 15%.
- Similarity score: nine metrics with weights `15/12/10/10/10/10/13/12/8` for Pearson, body, upper wick, lower wick, range, volume, momentum, trend, and pattern.
- Similarity threshold: 52%.
- Trend reference: closed 15-minute BTC and ETH candles, EMA-50/EMA-200.
- Trend safety: at least 200 valid candles are required; insufficient data returns `SIDEWAYS` with zero confidence.
- Market trend: BTC 50% + ETH 25% + market breadth 25%; a strong BTC/ETH direction conflict blocks entries.
- PAPER aggregate positions: unlimited; same coin: maximum 1.
- Future LIVE safety cap: 5 simultaneous positions.
- Maximum position notional: 50 USDT.
- Ambush timeout: 15 minutes by default; candidates may be rebuilt on the next scan.
- Market breadth: hybrid 24-hour universe plus closed 15-minute momentum. It actively contributes 25% of the weighted market-trend score.

The authoritative list of settings and descriptions is [.env.example](.env.example).

## Requirements

- Node.js 20 recommended (minimum supported: Node.js 18)
- npm
- Binance API credentials are not required in PAPER mode; LIVE requires explicit credentials and real-trading authorization
- Docker / Docker Compose only when container deployment is used

## Setup

### PowerShell (Windows)

```powershell
npm ci
Copy-Item .env.example .env
notepad .env
npm run paper
```

### Bash (Linux/macOS)

```bash
npm ci
cp .env.example .env
${EDITOR:-nano} .env
npm run paper
```

Never commit `.env` or real credentials. Template values in `.env.example` must remain non-secret placeholders.

## Commands

The scripts use `cross-env`, so the same commands work in PowerShell, Command Prompt, Linux, and macOS.

```text
npm run paper
npm run testnet
npm run live
npm run dev
npm run lint
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
npm run build
```

Live mode additionally requires `ENABLE_REAL_TRADING=true`.

## Deterministic tests

Jest sets its own safe environment in `tests/setup-env.js`. When `NODE_ENV=test`, application configuration does not load the repository `.env`; local and production values therefore cannot change test defaults or leak into test execution.

```powershell
npm ci
npm run lint
npm test
npm run test:coverage
npm run build
```

CI runs lint, coverage-producing tests, syntax validation, and a Docker image build. The lockfile is committed and `npm ci` is used for reproducible dependency installation.

## Health endpoints

The application listens on `HEALTH_HOST` / `HEALTH_PORT` (defaults: `0.0.0.0:3000`).

- `GET /health`: liveness; returns HTTP 200 while the process and HTTP server are alive.
- `GET /ready`: readiness; returns HTTP 503 during startup and HTTP 200 after the trading loop and position monitor have started.

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/ready
```

Docker and Docker Compose use `/health` for the container health check.

## Docker

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f gptsono
```

Compose mounts the local `.env`, `data`, and `logs`. For a standalone `docker run` example, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Important configuration names

```env
APP_MODE=paper
NODE_ENV=production
BINANCE_API_KEY=CHANGE_ME
BINANCE_API_SECRET=CHANGE_ME
ENABLE_REAL_TRADING=false
MAX_DAILY_LOSS_PERCENT=5
MAX_MONTHLY_LOSS_PERCENT=5
MAX_POSITIONS=10
SIMILARITY_THRESHOLD=51
SNIPER_MAX_WAIT_MINUTES=30
AMBUSH_TIMEOUT_MINUTES=15
BTC_TREND_INTERVAL=15m
BTC_TREND_CANDLE_LIMIT=250
MARKET_BREADTH_MODE=WEIGHTED_TREND
MARKET_TREND_BTC_WEIGHT=50
MARKET_TREND_ETH_WEIGHT=25
MARKET_TREND_BREADTH_WEIGHT=25
HEALTH_PORT=3000
```

Use the exact names from `.env.example`; legacy names such as `EXCHANGE_API_KEY`, `DAILY_LOSS_LIMIT`, `BTC_SIMILARITY_THRESHOLD`, and `CACHE_TTL_SECONDS` are not runtime settings.

## Runtime data and logs

- Runtime data: `data/`
- General log default: `logs/combined.log`
- Error log default: `logs/error.log`
- Trade snapshots: `data/trade-snapshots.json`

## License

Proprietary. See [LICENSE](LICENSE).
