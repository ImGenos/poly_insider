# Polymarket Monitoring Bot

Real-time surveillance system for Polymarket prediction markets. Detects anomalous trading patterns and delivers Telegram alerts with severity levels and blockchain explorer links.

## Architecture

```
Polymarket WebSocket
        │
        ▼
  [Ingestor Service]  ──XADD──▶  Redis Stream (trades:stream)
                                          │
                                          ▼
                                 [Analyzer Service]
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                    AnomalyDetector  ClusterDetector  BlockchainAnalyzer
                          │               │               │
                          └───────────────┴───────────────┘
                                          │
                                          ▼
                                  TelegramNotifier
```

Two decoupled PM2 processes communicate via a Redis Stream. TimescaleDB stores time-series price history and cluster trades for statistical baselines.

- **Ingestor** — maintains the WebSocket connection, normalizes trades, pushes to `trades:stream`
- **Analyzer** — consumes the stream, runs the full detection pipeline, sends alerts
- **Redis** — stream transport, wallet profile cache, alert deduplication
- **TimescaleDB** — durable time-series storage for Z-score baselines

## Prerequisites

- Node.js 20.x
- Docker and Docker Compose
- PM2 (`npm install -g pm2`)
- Ubuntu VPS (1 vCPU, 2 GB RAM minimum recommended)

## Setup

```bash
git clone <repo-url>
cd polymarket-monitoring-bot
npm install
npm run build
cp .env.example .env
# Edit .env and fill in required values
```

## Infrastructure

Start Redis and TimescaleDB:

```bash
docker compose up -d
```

This starts:
- Redis 7 on port `6379` with AOF persistence
- TimescaleDB (PostgreSQL 15) on port `5432`

The schema (hypertables, indexes, continuous aggregate) is created automatically on first startup.

## PM2 Deployment

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

This starts two processes:
- `polymarket-ingestor` — 256 MB memory limit, logs to `./logs/ingestor-*.log`
- `polymarket-analyzer` — 500 MB memory limit, logs to `./logs/analyzer-*.log`

## Monitoring

```bash
# Live process dashboard
pm2 monit

# Tail logs
pm2 logs polymarket-ingestor
pm2 logs polymarket-analyzer

# Check Redis stream depth (pending messages)
redis-cli XLEN trades:stream

# Check consumer group lag
redis-cli XINFO GROUPS trades:stream
```

## Testing

```bash
npm test                          # all tests
npm run test:unit                 # unit tests only
npm run test:integration          # integration tests only
npm run test:property             # property-based tests only
```

## Configuration Reference

Copy `.env.example` to `.env`. Required variables must be set before starting.

### Required

| Variable | Type | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | string | Telegram Bot API token from @BotFather |
| `TELEGRAM_CHAT_ID` | string | Chat ID or @username to receive alerts |
| `ALCHEMY_API_KEY` | string | Alchemy API key for wallet profiling |
| `REDIS_URL` | string | Redis connection URL (e.g. `redis://localhost:6379`) |
| `TIMESCALEDB_URL` | string | PostgreSQL connection URL (e.g. `postgresql://polymarket:polymarket@localhost:5432/polymarket`) |
| `POLYMARKET_WS_URL` | string | Polymarket CLOB WebSocket endpoint |

### Detection Thresholds (Optional)

| Variable | Type | Default | Description |
|---|---|---|---|
| `MIN_TRADE_SIZE_USDC` | number | `5000` | Minimum trade size in USDC to pass noise filter |
| `RAPID_ODDS_SHIFT_PERCENT` | number | `15` | Price change % within window to trigger rapid odds shift alert |
| `RAPID_ODDS_SHIFT_WINDOW_MINUTES` | number | `5` | Time window in minutes for rapid odds shift detection |
| `WHALE_ACTIVITY_PERCENT` | number | `20` | % of order book liquidity consumed to trigger whale alert |
| `INSIDER_WALLET_AGE_HOURS` | number | `48` | Max wallet age in hours to qualify as "new" for insider detection |
| `INSIDER_MIN_TRADE_SIZE` | number | `10000` | Min trade size in USDC for insider trading detection |
| `CLUSTER_WINDOW_MINUTES` | number | `10` | Time window in minutes for coordinated cluster detection |
| `CLUSTER_MIN_WALLETS` | number | `3` | Minimum distinct wallets to trigger a cluster alert (min: 2) |
| `ZSCORE_THRESHOLD` | number | `3.0` | Standard deviations required to trigger a Z-score anomaly |
| `ZSCORE_MIN_SAMPLES` | number | `30` | Minimum samples before Z-score detection activates |
| `ZSCORE_BASELINE_WINDOW` | number | `100` | Historical data points used for Z-score baseline |
| `NICHE_MARKET_CATEGORIES` | string | `sports,crypto` | Comma-separated market categories considered "niche" for insider detection |
| `KNOWN_EXCHANGE_WALLETS` | string | `` | Comma-separated known exchange wallet addresses excluded from funder detection |
| `ALERT_DEDUP_TTL_SECONDS` | number | `3600` | TTL in seconds for alert deduplication keys |
| `CLUSTER_DEDUP_TTL_SECONDS` | number | `600` | TTL in seconds for cluster alert deduplication keys |

### Logging (Optional)

| Variable | Type | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | string | `info` | Log level: `debug`, `info`, `warn`, or `error` |
| `LOG_FILE_PATH` | string | `` | Absolute path to log file (omit to log to console only) |

### Fallback APIs (Optional)

| Variable | Type | Default | Description |
|---|---|---|---|
| `MORALIS_API_KEY` | string | `` | Moralis API key used as fallback when Alchemy wallet lookup fails |
