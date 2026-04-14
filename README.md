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
                          ┌───────────────┼───────────────┬──────────────────┐
                          ▼               ▼               ▼                  ▼
                    AnomalyDetector  ClusterDetector  BlockchainAnalyzer  SmartMoneyDetector
                          │               │               │                  │
                          └───────────────┴───────────────┴──────────────────┘
                                          │
                                          ▼
                                  TelegramNotifier
```

Two decoupled PM2 processes communicate via a Redis Stream. TimescaleDB stores time-series price history and cluster trades for statistical baselines.

- **Ingestor** — maintains the WebSocket connection, normalizes trades, pushes to `trades:stream`
- **Analyzer** — consumes the stream, runs the full detection pipeline, sends alerts
- **Redis** — stream transport, wallet profile cache, alert deduplication
- **TimescaleDB** — durable time-series storage for Z-score baselines
- **SmartMoneyDetector** — identifies experienced bettors on football markets using on-chain metrics

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

pm2 startup   # Non fonctionel sur pm2 windows
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

### Smart Money Detector (Optional)

| Variable | Type | Default | Description |
|---|---|---|---|
| `SMART_MONEY_MIN_TRADE_SIZE` | number | `5000` | Minimum trade size in USDC for smart money detection |
| `SMART_MONEY_CONFIDENCE_THRESHOLD` | number | `80` | Minimum confidence score (0-100) to trigger smart money alert |
| `SMART_MONEY_WALLET_CACHE_TTL` | number | `86400` | TTL in seconds for wallet profile cache (24 hours) |

### Logging (Optional)

| Variable | Type | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | string | `info` | Log level: `debug`, `info`, `warn`, or `error` |
| `LOG_FILE_PATH` | string | `` | Absolute path to log file (omit to log to console only) |

### Fallback APIs (Optional)

| Variable | Type | Default | Description |
|---|---|---|---|
| `MORALIS_API_KEY` | string | `` | Moralis API key used as fallback when Alchemy wallet lookup fails |

## Detection Features

### 1. Rapid Odds Shift Detection (Hybrid: Market-Level)
Identifies sudden price movements using **Polymarket Gamma API** for real-time market data.

**Primary Method**: Compares trade price against Polymarket's official mid-price (bestBid + bestAsk) / 2
- Direct access to market truth without waiting for local data accumulation
- Includes volume and liquidity context from Polymarket

**Fallback Chain**:
1. Z-score analysis on local price history (TimescaleDB)
2. Static percentage threshold

**Configuration**: `RAPID_ODDS_SHIFT_PERCENT`, `ZSCORE_THRESHOLD`

See [doc/HYBRID_ANOMALY_DETECTION.md](doc/HYBRID_ANOMALY_DETECTION.md) for details.

### 2. Whale Activity Detection (Hybrid: Wallet-Level Behavioral)
Detects large trades using **behavioral Z-score** analysis.

**Primary Method**: Compares current trade size to wallet's historical trading pattern via Alchemy
- Answers: "Is this trade unusual for THIS wallet?"
- Uses `alchemy_getAssetTransfers` to get wallet's last 100 USDC transfers
- Calculates Z-score: (current_size - wallet_avg) / wallet_stddev

**Example**: 
- Wallet normally trades 100-500 USDC → 1000 USDC trade = 7σ → 🚨 ANOMALY
- Whale normally trades 5k-15k USDC → 1000 USDC trade = -3σ → No alert

**Fallback Chain**:
1. Market-level Z-score (all trades on this market)
2. Liquidity consumption percentage
3. Absolute size threshold

**Configuration**: `WHALE_ACTIVITY_PERCENT`, `ZSCORE_THRESHOLD`

See [doc/HYBRID_ANOMALY_DETECTION.md](doc/HYBRID_ANOMALY_DETECTION.md) for details.

### 3. Insider Trading Detection
Identifies suspicious patterns from new wallets making large trades on niche markets.
- Analyzes wallet age, transaction count, and risk score
- Requires all three conditions: new wallet + large trade + niche market
- Configurable via `INSIDER_WALLET_AGE_HOURS` and `INSIDER_MIN_TRADE_SIZE`

### 4. Coordinated Cluster Detection
Detects multiple wallets trading the same side of a market within a short time window.
- Analyzes funding relationships between wallets
- Identifies common funders (excluding known exchanges)
- Configurable via `CLUSTER_WINDOW_MINUTES` and `CLUSTER_MIN_WALLETS`

### 5. Smart Money Detection (Football Markets)
**NEW**: Identifies experienced, high-performing bettors on football markets.

#### Features:
- **Market Filtering**: Only processes football-related markets (Champions League, Premier League, etc.)
- **Bettor Confidence Index**: Calculates a 0-100 score based on:
  - Historical PnL (40% weight)
  - Recent trading volume (20% weight)
  - Bet size ratio vs. average (25% weight)
  - Win rate (15% weight)
- **Intelligent Caching**: Redis cache with 24h TTL to avoid API spam
- **Historical Storage**: TimescaleDB hypertable for performance tracking

#### Alert Criteria:
- Market must be football-related
- Trade size ≥ `SMART_MONEY_MIN_TRADE_SIZE`
- Confidence score ≥ `SMART_MONEY_CONFIDENCE_THRESHOLD`

#### Severity Levels:
- **CRITICAL**: Score ≥ 90
- **HIGH**: Score ≥ 85
- **MEDIUM**: Score ≥ 80

See [doc/SMART_MONEY_DETECTOR.md](doc/SMART_MONEY_DETECTOR.md) for detailed documentation.

## Alert Examples

### Smart Money Alert
```
🚨 SMART MONEY DETECTED | HIGH

⚽ Football Market
Market: [Champions League Final - Real Madrid vs Bayern](link)
Side: YES
Amount: 15,000 USDC
Price: 65.0%

📊 Bettor Confidence Index: 87/100

Metrics:
• PnL: $45,000 (score: 90)
• Recent Volume: $80,000 (score: 80)
• Bet Size Ratio: 8.5x (score: 85)
• Win Rate: 65.0% (score: 83)

Wallet: [0x1234...5678](link)
```

### Whale Activity Alert
```
🚨 WHALE ACTIVITY | HIGH

Market: [2024 US Presidential Election](link)
Side: YES
Size: 50,000 USDC
Z-score: 4.2σ
Confidence: 85%

Wallet: [0xabcd...ef01](link)
```

### Coordinated Cluster Alert
```
🚨 COORDINATED WALLET CLUSTER | CRITICAL

Market: [Bitcoin to reach $100k by EOY](link)
Side: YES
Total size: 75,000 USDC
Wallets: 5 in last 10min

Common Funder:
[0x9876...5432](link)

Funded Wallets:
• [0x1111...2222](link)
• [0x3333...4444](link)
• [0x5555...6666](link)
• [0x7777...8888](link)
• [0x9999...0000](link)
```

## Database Schema

### TimescaleDB Tables

#### `price_history`
Stores all trade prices for Z-score baseline calculation.
```sql
CREATE TABLE price_history (
  time        TIMESTAMPTZ NOT NULL,
  market_id   TEXT NOT NULL,
  price       DOUBLE PRECISION NOT NULL,
  size_usd    DOUBLE PRECISION NOT NULL
);
```

#### `cluster_trades`
Stores trades for coordinated cluster detection.
```sql
CREATE TABLE cluster_trades (
  time            TIMESTAMPTZ NOT NULL,
  market_id       TEXT NOT NULL,
  side            TEXT NOT NULL,
  wallet_address  TEXT NOT NULL,
  size_usd        DOUBLE PRECISION NOT NULL
);
```

#### `smart_money_trades`
Stores smart money detections with full confidence metrics.
```sql
CREATE TABLE smart_money_trades (
  time                TIMESTAMPTZ NOT NULL,
  market_id           TEXT NOT NULL,
  market_name         TEXT NOT NULL,
  side                TEXT NOT NULL,
  wallet_address      TEXT NOT NULL,
  size_usd            DOUBLE PRECISION NOT NULL,
  price               DOUBLE PRECISION NOT NULL,
  confidence_score    INTEGER NOT NULL,
  pnl                 DOUBLE PRECISION NOT NULL,
  recent_volume       DOUBLE PRECISION NOT NULL,
  bet_size_ratio      DOUBLE PRECISION NOT NULL,
  win_rate            DOUBLE PRECISION NOT NULL
);
```

## License

MIT
