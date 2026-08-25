# GPTSONO Deployment Guide

## 1. Prerequisites

- Node.js 20 recommended (minimum 18)
- npm
- Git
- Docker and Docker Compose when using containers
- Binance credentials appropriate to the selected mode

Start in paper mode. Live mode sends real orders and requires both `APP_MODE=live` and `ENABLE_REAL_TRADING=true`.

## 2. Install

### PowerShell (Windows)

```powershell
git clone https://github.com/dtepe42-dev/gptsonoev.git
Set-Location gptsonoev
npm ci
Copy-Item .env.example .env
notepad .env
```

### Bash (Linux/macOS)

```bash
git clone https://github.com/dtepe42-dev/gptsonoev.git
cd gptsonoev
npm ci
cp .env.example .env
${EDITOR:-nano} .env
```

Keep real credentials only in `.env`. Do not copy them into `.env.example`, documentation, commits, issues, or chat messages.

## 3. Configure

Minimum startup configuration:

```env
APP_MODE=paper
NODE_ENV=production
BINANCE_API_KEY=replace_locally
BINANCE_API_SECRET=replace_locally
ENABLE_REAL_TRADING=false
ENABLE_TELEGRAM=false
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3000
```

Testnet mode also uses `BINANCE_TESTNET_API_KEY` and `BINANCE_TESTNET_API_SECRET`. Live mode must use restricted keys, an IP allow-list where possible, Futures trading permission only, and no withdrawal permission.

Useful risk settings:

```env
LEVERAGE=1
MAX_POSITIONS=1
INITIAL_TP_PERCENT=1
STOP_LOSS_PERCENT=1
MAX_DAILY_LOSS_PERCENT=1
MAX_MONTHLY_LOSS_PERCENT=5
```

Refer to `.env.example` for every supported name. In particular, use `INITIAL_TP_PERCENT` / `TP_PERCENT`, `CACHE_TTL`, and `LOG_ERROR_FILE=logs/error.log`.

## 4. Validate before starting

```powershell
npm run lint
npm test
npm run test:coverage
npm run build
```

Tests are isolated from the project `.env` and use safe values from `tests/setup-env.js`.

## 5. Run without Docker

```powershell
npm run paper
# npm run testnet
# npm run live
```

The commands are cross-platform and work in PowerShell and Bash.

Verify the process:

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/ready
Get-Content logs/combined.log -Wait
```

On Linux, use `curl http://localhost:3000/health` and `tail -f logs/combined.log`.

## 6. Docker Compose

The compose file loads `.env`, mounts persistent `data/` and `logs/`, publishes port 3000, and includes a health check.

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f gptsono
```

## 7. Standalone Docker

```powershell
docker build -t gptsono:latest .
docker run -d --name gptsono --restart unless-stopped --env-file .env -p 3000:3000 -v "${PWD}/data:/app/data" -v "${PWD}/logs:/app/logs" gptsono:latest
docker inspect --format='{{json .State.Health}}' gptsono
```

On Bash, use `-v "$(pwd)/data:/app/data"` and `-v "$(pwd)/logs:/app/logs"`.

## 8. Health behavior

- `GET /health` is the Docker liveness endpoint and returns 200 when the HTTP service is alive.
- `GET /ready` returns 503 during initialization and 200 after the trading components start.
- Default address: `0.0.0.0:3000`.
- Docker retries every 30 seconds after its startup grace period.

## 9. Production checklist

- [ ] Paper and testnet validation completed
- [ ] `npm run lint`, `npm test`, `npm run test:coverage`, and `npm run build` pass
- [ ] API credentials are rotated, restricted, and absent from Git history
- [ ] `.env` permissions and host access are restricted
- [ ] Live mode limits are conservative and reviewed
- [ ] Persistent data and log backups are configured
- [ ] Health and readiness endpoints are monitored
- [ ] Restart policy and incident rollback procedure are tested

## 10. Troubleshooting

### Missing required environment variables

Confirm `.env` exists and contains `APP_MODE`, `NODE_ENV`, `BINANCE_API_KEY`, and `BINANCE_API_SECRET`.

### Container is unhealthy

```powershell
docker compose logs gptsono
docker compose exec gptsono wget -qO- http://127.0.0.1:3000/health
```

### Configuration or strategy does not match expectations

Check the exact variable name and value in `.env.example`. Restart the process after changes. Market breadth uses `MARKET_BREADTH_MODE=WEIGHTED_TREND` and contributes 25% of the market trend score.

### Logs

General logs default to `logs/combined.log`; errors default to `logs/error.log`.

