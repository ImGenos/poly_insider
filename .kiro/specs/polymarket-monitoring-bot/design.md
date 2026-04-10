# Design Document: Polymarket Real-Time Monitoring Bot

## Overview

The Polymarket Monitoring Bot is a production-ready microservice system that provides 24/7 real-time surveillance of the Polymarket prediction market platform. The architecture is split into two decoupled services connected by a Redis Stream: the **Ingestor** maintains the WebSocket connection to Polymarket's CLOB API and pushes normalized trades into the stream at maximum speed, while the **Analyzer** reads from the stream, runs the full detection pipeline, and sends Telegram alerts — ensuring that WebSocket frame ingestion is never blocked by downstream processing latency.

State is split across two purpose-built stores: **Redis** handles wallet profile caching (as Redis Hashes) and alert deduplication (via TTL-native `SETEX` keys), while **TimescaleDB** (a PostgreSQL extension) stores time-series price history and cluster trades as hypertables, enabling native rolling-window queries and continuous aggregate views for per-market volatility baselines. Anomaly detection uses **Z-score statistical thresholds** derived from these baselines rather than hardcoded percentages, automatically adapting to each market's volatility profile and falling back to static thresholds for new markets with insufficient data.

A fourth upgrade adds **graph-based cluster funding analysis**: when a coordinated wallet cluster is detected, the system queries Alchemy's `alchemy_getAssetTransfers` to find the first inbound transaction for each wallet and checks whether multiple cluster wallets share a common non-exchange funder. If they do, the anomaly severity is upgraded to `CRITICAL` and the alert includes the shared funder address and funding graph. Wallet profiling uses Alchemy's `alchemy_getAssetTransfers` endpoint to retrieve a wallet's first-ever transaction in a single HTTP call. Built for resilience with PM2 process management, the system features automatic reconnection logic, configurable thresholds, and comprehensive error handling to ensure continuous operation on Ubuntu VPS infrastructure.

## Architecture

```mermaid
graph TD
    A[Polymarket CLOB WebSocket API] -->|Real-time Trade Stream| B[WebSocket Manager]
    B -->|Connection Events| C[Reconnection Handler]
    C -->|Exponential Backoff| B
    B -->|Normalized NormalizedTrade| D[Ingestor Service]
    D -->|XADD trades:stream| E[Redis Stream]
    E -->|XREADGROUP analyzers| F[Analyzer Service]
    F -->|Filtered Trades| G[Trade Filter]
    G -->|Filtered Trades| H[Anomaly Detector]
    G -->|Filtered Trades| I[Cluster Detector]
    H -->|getMarketVolatility| J[TimeSeriesDB - TimescaleDB]
    I -->|recordClusterTrade / getClusterWallets| J
    H -->|getWalletProfile / saveWalletProfile| K[RedisCache]
    I -->|hasClusterAlertBeenSent| K
    H -->|Cache Miss: Wallet Query| L[Alchemy Indexer API]
    I -->|analyzeClusterFunding| L
    L -->|First TX / Funder Address| H
    H -->|Anomaly Detected| M[Alert Formatter]
    I -->|ClusterAnomaly + FundingAnalysis| M
    M -->|hasAlertBeenSent| K
    M -->|Rich Message| N[Telegram Bot API]
    N -->|Push Notification| O[User Telegram Client]
    P[Configuration Manager] -->|Thresholds| G
    P -->|Detection Params| H
    P -->|Cluster Params| I
    Q[Logger] -->|Logs| R[Log Files]
    H -->|appendPricePoint| J
```


## Main Algorithm/Workflow

```mermaid
sequenceDiagram
    participant Ingestor as Ingestor Service
    participant Stream as Redis Stream (trades:stream)
    participant Analyzer as Analyzer Service
    participant Filter as Trade Filter
    participant Detector as Anomaly Detector
    participant Cluster as Cluster Detector
    participant Redis as RedisCache
    participant TSDB as TimeSeriesDB (TimescaleDB)
    participant Alchemy as Alchemy Indexer API
    participant Alert as Alert Formatter
    participant TG as Telegram API
    
    Ingestor->>Ingestor: Connect to Polymarket CLOB WebSocket
    loop Every Trade Event
        Ingestor->>Ingestor: Normalize raw JSON → NormalizedTrade
        Ingestor->>Stream: XADD trades:stream * fields...
    end
    
    loop Analyzer Consumer Loop
        Analyzer->>Stream: XREADGROUP GROUP analyzers consumer1 COUNT 10 BLOCK 100
        Stream-->>Analyzer: Batch of NormalizedTrade messages
        
        loop For each trade in batch
            Analyzer->>Filter: NormalizedTrade
            Filter->>Filter: Check size >= threshold
            alt Trade below threshold
                Filter->>Analyzer: null (skip)
            else Trade above threshold
                Filter->>Detector: FilteredTrade
                Filter->>Cluster: FilteredTrade (recordTrade)
                Cluster->>TSDB: INSERT into cluster_trades hypertable
                Cluster->>TSDB: SELECT distinct wallets in window
                TSDB-->>Cluster: Wallet list
                alt Cluster threshold met
                    Cluster->>Alchemy: analyzeClusterFunding(wallets)
                    Alchemy-->>Cluster: FundingAnalysis
                    alt Common non-exchange funder found
                        Cluster->>Alert: ClusterAnomaly (CRITICAL + FundingAnalysis)
                    else No common funder
                        Cluster->>Alert: ClusterAnomaly (HIGH/MEDIUM)
                    end
                end
                Detector->>TSDB: getPriceHistory(marketId)
                TSDB-->>Detector: Recent price points
                Detector->>TSDB: getMarketVolatility(marketId, windowMinutes)
                TSDB-->>Detector: MarketVolatility (mean, stddev, sampleCount)
                alt sampleCount >= ZSCORE_MIN_SAMPLES
                    Detector->>Detector: Z-score anomaly detection
                else Insufficient baseline
                    Detector->>Detector: Static threshold fallback
                end
                Detector->>Redis: getWalletProfile(address)
                Redis-->>Detector: Cached profile or null
                alt Cache miss
                    Detector->>Alchemy: getAssetTransfers(address, maxCount=1, order=asc)
                    Alchemy-->>Detector: First transaction (1 HTTP call)
                    Detector->>Redis: saveWalletProfile(profile)
                end
                Detector->>TSDB: appendPricePoint(marketId, point)
                alt Anomaly detected
                    Detector->>Alert: Anomaly data
                    Alert->>Redis: hasAlertBeenSent(type, marketId, wallet)
                    Redis-->>Alert: boolean (TTL-based)
                    alt Not a duplicate
                        Alert->>Alert: Format rich message
                        Alert->>TG: Send alert
                        TG-->>Alert: Delivery confirmation
                        Alert->>Redis: recordSentAlert(..., ttlSeconds)
                    end
                end
            end
        end
        Analyzer->>Stream: XACK trades:stream analyzers <id>
    end
    
    Note over Ingestor: On disconnect
    Ingestor->>Ingestor: Exponential backoff retry
```

## Components and Interfaces

### Component 1: WebSocket Manager

**Purpose**: Manages persistent connection to Polymarket CLOB WebSocket API with automatic reconnection

**Interface**:
```typescript
interface WebSocketManager {
  connect(): Promise<void>
  disconnect(): Promise<void>
  onTrade(callback: (trade: RawTrade) => void): void
  onError(callback: (error: Error) => void): void
  onReconnect(callback: () => void): void
  isConnected(): boolean
}
```

**Responsibilities**:
- Establish and maintain WebSocket connection to Polymarket CLOB API
- Implement exponential backoff reconnection strategy (1s, 2s, 4s, 8s, max 60s)
- Parse incoming WebSocket messages into structured trade objects
- Emit trade events to registered listeners
- Handle connection errors and network failures gracefully
- Provide connection health status

### Component 2: Trade Filter

**Purpose**: Filters incoming trades based on configurable thresholds to reduce noise

**Interface**:
```typescript
interface TradeFilter {
  filter(trade: RawTrade): FilteredTrade | null
  setMinimumSize(sizeUSDC: number): void
  getMinimumSize(): number
}
```

**Responsibilities**:
- Apply minimum trade size threshold (default: $5,000 USDC)
- Normalize trade data structure
- Reject trades below configured thresholds
- Pass qualifying trades to anomaly detection engine



### Component 3: Anomaly Detection Engine

**Purpose**: Analyzes filtered trades for suspicious patterns using Z-score statistical baselines with static threshold fallback

**Interface**:
```typescript
interface AnomalyDetector {
  analyze(trade: FilteredTrade): Promise<Anomaly[]>
  detectRapidOddsShift(trade: FilteredTrade, priceHistory: PricePoint[], volatility: MarketVolatility | null, staticThresholdPercent: number, zScoreThreshold: number): Anomaly | null
  detectWhaleActivity(trade: FilteredTrade, volatility: MarketVolatility | null, staticThresholdPercent: number, zScoreThreshold: number): Anomaly | null
  detectInsiderTrading(trade: FilteredTrade): Promise<Anomaly | null>
  updateMarketState(trade: FilteredTrade): void
}
```

**Responsibilities**:
- Fetch per-market volatility baseline from `TimeSeriesDB.getMarketVolatility()` before each detection run
- Use Z-score detection when `volatility.sampleCount >= ZSCORE_MIN_SAMPLES` (default: 30); fall back to static thresholds otherwise
- Detect rapid odds shifts: flag if Z-score of price change >= `ZSCORE_THRESHOLD` (default: 3.0 sigma)
- Identify whale transactions: flag if trade size Z-score >= `ZSCORE_THRESHOLD` above market's normal trade size distribution
- Query Redis cache (via `RedisCache`) for wallet profiles before calling Alchemy
- Flag new wallets (<48 hours old) making large trades on niche markets
- Calculate insider probability score
- Return array of detected anomalies with severity levels and Z-score metadata

### Component 4: Blockchain Analyzer

**Purpose**: Queries the Alchemy indexer API to analyze wallet behavior, history, and funding relationships

**Interface**:
```typescript
interface BlockchainAnalyzer {
  getWalletAge(address: string): Promise<number>
  getTransactionCount(address: string): Promise<number>
  isNewWallet(address: string, thresholdHours: number): Promise<boolean>
  analyzeWalletProfile(address: string, redisCache: RedisCache): Promise<WalletProfile>
  getWalletFunder(address: string): Promise<string | null>  // Returns 'from' address of first inbound tx
  analyzeClusterFunding(wallets: string[]): Promise<FundingAnalysis>
}
```

**Responsibilities**:
- Call Alchemy's `alchemy_getAssetTransfers` endpoint with `fromBlock: "0x0"`, `toAddress: address`, `maxCount: 1`, `order: "asc"` to retrieve the first-ever transaction in a single HTTP call
- `getWalletFunder()`: extract the `from` address of the first inbound transaction — used for funding graph analysis
- `analyzeClusterFunding()`: for each wallet in a cluster, call `getWalletFunder()` (Redis-cached), then group wallets by funder; detect shared non-exchange funders and return a `FundingAnalysis`
- Fall back to Moralis Web3 API `/{address}/verbose` endpoint if Alchemy is unavailable
- Check `RedisCache` before making any API call — return cached profile immediately on hit
- Cache funder addresses in Redis: `HSET wallet:{address} funder {funderAddress}`
- Calculate wallet age in hours from first transaction timestamp
- Implement rate limiting to avoid API throttling



### Component 5: Alert Formatter

**Purpose**: Transforms anomaly data into rich, human-readable Telegram messages

**Interface**:
```typescript
interface AlertFormatter {
  format(anomaly: Anomaly, trade: FilteredTrade): TelegramMessage
  formatRapidOddsShift(anomaly: Anomaly, trade: FilteredTrade): string
  formatWhaleAlert(anomaly: Anomaly, trade: FilteredTrade): string
  formatInsiderAlert(anomaly: Anomaly, trade: FilteredTrade): string
  formatClusterAlert(anomaly: ClusterAnomaly): string
}
```

**Responsibilities**:
- Generate formatted messages with emojis and markdown
- Include market name, side (Yes/No), trade size in USDC
- Add anomaly type and severity indicators
- Embed clickable links (PolygonScan wallet, Polymarket market URL)
- Apply appropriate emoji indicators (🚨 for high severity, ⚠️ for medium)
- Format numbers with proper thousand separators

### Component 6: Telegram Notifier

**Purpose**: Sends formatted alerts to configured Telegram chat via Bot API

**Interface**:
```typescript
interface TelegramNotifier {
  sendAlert(message: TelegramMessage): Promise<boolean>
  setToken(token: string): void
  setChatId(chatId: string): void
  testConnection(): Promise<boolean>
}
```

**Responsibilities**:
- Authenticate with Telegram Bot API using bot token
- Send messages to configured chat ID
- Handle Telegram API rate limits (30 messages/second)
- Retry failed sends with exponential backoff
- Provide delivery confirmation
- Support markdown formatting and link previews



### Component 7: Configuration Manager

**Purpose**: Manages application configuration with environment variables and defaults

**Interface**:
```typescript
interface ConfigManager {
  get(key: string): any
  set(key: string, value: any): void
  getThresholds(): DetectionThresholds
  getTelegramConfig(): TelegramConfig
  getAlchemyApiKey(): string
  getRedisUrl(): string
  getTimescaleDbUrl(): string
}
```

**Responsibilities**:
- Load configuration from environment variables
- Provide sensible defaults for all thresholds
- Validate configuration on startup
- Expose typed configuration objects
- Support runtime configuration updates (for testing)

### Component 8: Logger

**Purpose**: Provides structured logging with multiple severity levels

**Interface**:
```typescript
interface Logger {
  info(message: string, metadata?: object): void
  warn(message: string, metadata?: object): void
  error(message: string, error?: Error, metadata?: object): void
  debug(message: string, metadata?: object): void
}
```

**Responsibilities**:
- Write logs to console and file system
- Include timestamps and severity levels
- Support structured metadata (JSON format)
- Rotate log files daily
- Provide different log levels for production vs development



### Component 9: Redis Cache

**Purpose**: Provides fast, TTL-native caching for wallet profiles and alert deduplication using Redis

**Interface**:
```typescript
interface RedisCache {
  getWalletProfile(address: string): Promise<WalletProfile | null>
  saveWalletProfile(profile: WalletProfile): Promise<void>
  hasAlertBeenSent(type: string, marketId: string, walletAddress: string): Promise<boolean>
  recordSentAlert(type: string, marketId: string, walletAddress: string, ttlSeconds: number): Promise<void>
  hasClusterAlertBeenSent(marketId: string, side: string): Promise<boolean>
  recordClusterAlert(marketId: string, side: string, ttlSeconds: number): Promise<void>
  pushToStream(streamKey: string, fields: Record<string, string>): Promise<string>
  readFromStream(streamKey: string, group: string, consumer: string, count: number): Promise<StreamMessage[]>
  acknowledgeMessage(streamKey: string, group: string, messageId: string): Promise<void>
  getStreamDepth(streamKey: string): Promise<number>
}
```

**Responsibilities**:
- `wallet_profiles`: stored as Redis Hash — `HSET wallet:{address} first_tx_timestamp {val} tx_count {val} age_hours {val} is_new {val} risk_score {val} funder {val}`; no TTL (permanent cache)
- `sent_alerts` deduplication: `SETEX alert:{type}:{marketId}:{walletAddress} {ttlSeconds} 1` — TTL-native, zero custom pruning logic
- Cluster deduplication: `SETEX cluster:{marketId}:{side} {ttlSeconds} 1`
- Redis Stream operations: `XADD` (push), `XREADGROUP` (consume), `XACK` (acknowledge), `XLEN` (depth monitoring)
- Stream key: `trades:stream`; consumer group: `analyzers`; max stream length: `MAXLEN ~ 100000`
- Implemented via `ioredis` (^5.3.0)

### Component 10: Time-Series Database

**Purpose**: Provides durable, time-series-optimized persistence for price history and cluster trades using TimescaleDB

**Interface**:
```typescript
interface TimeSeriesDB {
  appendPricePoint(marketId: string, price: number, timestamp: Date): Promise<void>
  getPriceHistory(marketId: string, since: Date): Promise<PricePoint[]>
  getMarketVolatility(marketId: string, windowMinutes: number): Promise<MarketVolatility>
  recordClusterTrade(trade: FilteredTrade): Promise<void>
  getClusterWallets(marketId: string, side: string, since: Date): Promise<string[]>
  getClusterTotalSize(marketId: string, side: string, since: Date): Promise<number>
}
```

**Responsibilities**:
- `price_history` hypertable: `market_id`, `price`, `time` — partitioned by time automatically via TimescaleDB
- `cluster_trades` hypertable: `market_id`, `side`, `wallet_address`, `size_usd`, `time`
- `getMarketVolatility()`: queries the `market_volatility_1h` continuous aggregate view for rolling mean and stddev of price changes and trade sizes
- Async inserts via `pg` (node-postgres) — non-blocking, never stalls the Node.js event loop
- On startup, volatility baselines are loaded from TimescaleDB (survives restarts)
- Implemented via `pg` (^8.11.0)

### Component 11: Cluster Detector

**Purpose**: Detects coordinated wallet activity — multiple distinct wallets trading the same side of the same market within a configurable time window — and runs funding graph analysis to detect shared funders

**Interface**:
```typescript
interface ClusterDetector {
  recordTrade(trade: FilteredTrade): Promise<void>
  detectCluster(trade: FilteredTrade): Promise<ClusterAnomaly | null>
}
```

**Responsibilities**:
- Call `TimeSeriesDB.recordClusterTrade()` for every filtered trade to persist it to the `cluster_trades` hypertable
- After recording, query `TimeSeriesDB.getClusterWallets()` to count distinct wallets on the same market/side within the configured window
- If distinct wallet count >= `CLUSTER_MIN_WALLETS` (default: 3), proceed to funding analysis
- Call `BlockchainAnalyzer.analyzeClusterFunding(wallets)` when severity is HIGH (>= 5 wallets) or MEDIUM (>= 3 wallets)
- If `FundingAnalysis.hasCommonNonExchangeFunder === true`: upgrade severity to `CRITICAL` and attach `fundingAnalysis` to the `ClusterAnomaly`
- If the shared funder is a known exchange hot wallet: note it in the alert but do NOT upgrade severity
- Use `CLUSTER_WINDOW_MINUTES` (default: 10) as the lookback window
- Deduplicate cluster alerts via `RedisCache.hasClusterAlertBeenSent()` to avoid re-alerting on the same cluster within the window

### Component 12: Ingestor Service

**Purpose**: Hyper-fast, single-responsibility service that maintains the WebSocket connection and pushes normalized trades to the Redis Stream without ever blocking on downstream processing

**Interface**:
```typescript
interface IngestorService {
  start(): Promise<void>
  stop(): Promise<void>
  getStreamDepth(): Promise<number>  // Monitor backpressure
}
```

**Responsibilities**:
- Maintain the WebSocket connection to Polymarket CLOB API
- Normalize raw JSON into a `NormalizedTrade` object
- Push to Redis Stream: `XADD trades:stream MAXLEN ~ 100000 * market_id {val} market_name {val} side {val} price {val} size_usd {val} timestamp {val} maker_address {val} taker_address {val} bid_liquidity {val} ask_liquidity {val}`
- Must NEVER block on downstream processing — fire-and-forget stream push
- Implement exponential backoff reconnection (1s, 2s, 4s, 8s, max 60s)
- Expose `getStreamDepth()` for backpressure monitoring
- Runs as its own PM2 process: `polymarket-ingestor`



## Data Models

### Model 1: RawTrade

```typescript
interface RawTrade {
  market_id: string
  market_name: string
  side: 'YES' | 'NO'
  price: number  // Share price (0-1 range)
  size: number   // Size in shares
  size_usd: number  // Size in USDC
  timestamp: number  // Unix timestamp
  maker_address: string
  taker_address: string
  order_book_depth: {
    bid_liquidity: number
    ask_liquidity: number
  }
}
```

**Validation Rules**:
- market_id must be non-empty string
- side must be exactly 'YES' or 'NO'
- price must be between 0 and 1
- size and size_usd must be positive numbers
- timestamp must be valid Unix timestamp
- maker_address and taker_address must be valid Ethereum addresses (0x + 40 hex chars)

### Model 2: FilteredTrade

```typescript
interface FilteredTrade {
  marketId: string
  marketName: string
  side: 'YES' | 'NO'
  price: number
  sizeUSDC: number
  timestamp: Date
  walletAddress: string  // Primary wallet (taker for buys, maker for sells)
  orderBookLiquidity: number
  marketCategory?: string  // 'sports' | 'crypto' | 'politics' | 'other'
}
```

**Validation Rules**:
- All fields from RawTrade normalized to camelCase
- timestamp converted to Date object
- walletAddress is the relevant address for anomaly detection
- orderBookLiquidity is total available liquidity on the side being consumed
- sizeUSDC must be >= configured minimum threshold



### Model 3: Anomaly

```typescript
interface Anomaly {
  type: 'RAPID_ODDS_SHIFT' | 'WHALE_ACTIVITY' | 'INSIDER_TRADING' | 'COORDINATED_MOVE'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  confidence: number  // 0-1 score
  details: {
    description: string
    metrics: Record<string, any>
  }
  detectedAt: Date
}
```

**Validation Rules**:
- type must be one of the four defined anomaly types
- severity must be LOW, MEDIUM, HIGH, or CRITICAL
- confidence must be between 0 and 1
- details.description must be non-empty string
- detectedAt must be valid Date object

### Model 4: WalletProfile

```typescript
interface WalletProfile {
  address: string
  firstTransactionTimestamp: number | null
  transactionCount: number
  ageHours: number | null
  isNew: boolean  // True if age < 48 hours
  riskScore: number  // 0-100 calculated risk score
}
```

**Validation Rules**:
- address must be valid Ethereum address
- firstTransactionTimestamp null if wallet has no transactions
- transactionCount must be non-negative integer
- ageHours null if wallet has no transactions
- isNew is true if ageHours < 48 and transactionCount is low
- riskScore between 0 and 100



### Model 5: DetectionThresholds

```typescript
interface DetectionThresholds {
  minTradeSizeUSDC: number  // Default: 5000
  rapidOddsShiftPercent: number  // Default: 15 (static fallback)
  rapidOddsShiftWindowMinutes: number  // Default: 5
  whaleActivityPercent: number  // Default: 20 (static fallback)
  insiderWalletAgeHours: number  // Default: 48
  insiderMinTradeSize: number  // Default: 10000
  nicheMarketCategories: string[]  // Default: ['sports', 'crypto']
  clusterWindowMinutes: number  // Default: 10
  clusterMinWallets: number  // Default: 3
  zScoreThreshold: number  // Default: 3.0
  zScoreMinSamples: number  // Default: 30 (min data points before Z-score activates)
  zScoreBaselineWindow: number  // Default: 100 (number of recent price points for baseline)
}
```

**Validation Rules**:
- All numeric thresholds must be positive
- Percentages should be reasonable (0-100 range)
- nicheMarketCategories must be non-empty array
- clusterMinWallets must be >= 2
- zScoreThreshold must be positive (typically 2.0–4.0)
- zScoreMinSamples must be >= 10

### Model 6: TelegramMessage

```typescript
interface TelegramMessage {
  text: string  // Markdown-formatted message
  parse_mode: 'Markdown' | 'HTML'
  disable_web_page_preview: boolean
}
```

**Validation Rules**:
- text must be non-empty and <= 4096 characters (Telegram limit)
- parse_mode must be valid Telegram parse mode
- Must contain properly escaped markdown if parse_mode is 'Markdown'



### Model 7: ClusterAnomaly

```typescript
interface ClusterAnomaly {
  type: 'COORDINATED_MOVE'
  marketId: string
  marketName: string
  side: 'YES' | 'NO'
  wallets: string[]  // All distinct wallet addresses in the cluster
  totalSizeUSDC: number
  windowMinutes: number
  detectedAt: Date
  severity: 'MEDIUM' | 'HIGH' | 'CRITICAL'  // CRITICAL when common non-exchange funder found
  fundingAnalysis?: FundingAnalysis           // Present when severity is CRITICAL
}
```

**Validation Rules**:
- type must be exactly 'COORDINATED_MOVE'
- wallets must contain >= 2 distinct addresses
- totalSizeUSDC must be positive
- windowMinutes must match configured CLUSTER_WINDOW_MINUTES
- severity is CRITICAL if fundingAnalysis.hasCommonNonExchangeFunder, HIGH if wallets.length >= 5, MEDIUM if >= 3
- fundingAnalysis is required when severity === 'CRITICAL'

### Model 8: MarketVolatility

```typescript
interface MarketVolatility {
  marketId: string
  avgPriceChange: number      // Rolling mean of price changes
  stddevPriceChange: number   // Rolling standard deviation
  avgTradeSize: number        // Rolling mean of trade sizes
  stddevTradeSize: number     // Rolling standard deviation of trade sizes
  sampleCount: number         // Number of data points in baseline
  lastUpdated: Date
}
```

**Validation Rules**:
- marketId must be non-empty string
- stddevPriceChange and stddevTradeSize must be >= 0
- sampleCount must be non-negative integer
- Z-score detection only activates when sampleCount >= ZSCORE_MIN_SAMPLES (default: 30)

### Model 9: FundingAnalysis

```typescript
interface FundingAnalysis {
  wallets: string[]
  funders: Map<string, string>        // wallet -> funder address
  sharedFunders: Map<string, string[]>  // funder -> list of wallets it funded
  hasCommonNonExchangeFunder: boolean
  commonFunderAddress: string | null
  isKnownExchange: boolean
  exchangeName: string | null    // e.g., "Binance", "Coinbase"
}
```

**Validation Rules**:
- wallets must be non-empty array of valid Ethereum addresses
- hasCommonNonExchangeFunder is true only when a funder funds >= 2 wallets AND is not in the known exchange list
- isKnownExchange and exchangeName are set when the shared funder matches a known exchange hot wallet
- commonFunderAddress is null when hasCommonNonExchangeFunder is false

### Model 10: NormalizedTrade (Ingestor Output)

```typescript
interface NormalizedTrade {
  market_id: string
  market_name: string
  side: 'YES' | 'NO'
  price: number
  size_usd: number
  timestamp: number  // Unix timestamp ms
  maker_address: string
  taker_address: string
  bid_liquidity: number
  ask_liquidity: number
}
```

**Validation Rules**:
- All fields required; this is the canonical message format pushed to `trades:stream`
- Field names use snake_case to match Redis Stream field conventions

### Model 11: TimescaleDB Schema

```sql
-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Price history hypertable
CREATE TABLE IF NOT EXISTS price_history (
  time        TIMESTAMPTZ NOT NULL,
  market_id   TEXT NOT NULL,
  price       DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('price_history', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_price_history_market ON price_history(market_id, time DESC);

-- Cluster trades hypertable
CREATE TABLE IF NOT EXISTS cluster_trades (
  time            TIMESTAMPTZ NOT NULL,
  market_id       TEXT NOT NULL,
  side            TEXT NOT NULL,
  wallet_address  TEXT NOT NULL,
  size_usd        DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('cluster_trades', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_cluster_trades_market_side ON cluster_trades(market_id, side, time DESC);

-- Market volatility baselines (continuous aggregate)
CREATE MATERIALIZED VIEW IF NOT EXISTS market_volatility_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  market_id,
  AVG(price) AS avg_price,
  STDDEV(price) AS stddev_price,
  COUNT(*) AS trade_count
FROM price_history
GROUP BY bucket, market_id;
```



## Key Functions with Formal Specifications

### Function 1: connectWebSocket()

```typescript
async function connectWebSocket(url: string, options: ConnectionOptions): Promise<WebSocket>
```

**Preconditions:**
- `url` is a valid WebSocket URL (starts with ws:// or wss://)
- `options` contains valid connection parameters
- Network connectivity is available

**Postconditions:**
- Returns connected WebSocket instance if successful
- WebSocket.readyState === WebSocket.OPEN
- Event listeners are registered for 'message', 'error', 'close'
- Throws ConnectionError if connection fails after max retries

**Loop Invariants:** N/A

### Function 2: filterTrade()

```typescript
function filterTrade(trade: RawTrade, threshold: number): FilteredTrade | null
```

**Preconditions:**
- `trade` is a valid RawTrade object with all required fields
- `threshold` is a positive number representing minimum USDC size
- `trade.size_usd` is a valid number

**Postconditions:**
- Returns FilteredTrade if `trade.size_usd >= threshold`
- Returns null if `trade.size_usd < threshold`
- No mutations to input `trade` object
- Returned FilteredTrade has normalized field names (camelCase)

**Loop Invariants:** N/A



### Function 3: detectRapidOddsShift()

```typescript
function detectRapidOddsShift(
  trade: FilteredTrade,
  priceHistory: PricePoint[],
  volatility: MarketVolatility | null,
  staticThresholdPercent: number,  // Fallback if volatility is null or insufficient samples
  zScoreThreshold: number          // Default: 3.0
): Anomaly | null
```

**Preconditions:**
- `trade` is a valid FilteredTrade object
- `priceHistory` contains price data for the same market within rolling window, sorted ascending
- `staticThresholdPercent` is a positive number (typically 15)
- `zScoreThreshold` is a positive number (typically 3.0)
- `volatility` may be null (new market) or have insufficient `sampleCount`

**Postconditions:**
- If `volatility !== null && volatility.sampleCount >= ZSCORE_MIN_SAMPLES`:
  - Calculates Z-score: `|priceChange - volatility.avgPriceChange| / volatility.stddevPriceChange`
  - Returns Anomaly if Z-score >= `zScoreThreshold`
  - `anomaly.confidence = Math.min(zScore / (zScoreThreshold * 2), 1.0)`
  - `anomaly.details.metrics` includes `zScore`, `avgPriceChange`, `stddevPriceChange`
- Else: falls back to static percentage threshold (change >= staticThresholdPercent)
- Returns null if threshold not met or insufficient data
- Anomaly.severity is HIGH if shift > 25% (or Z-score > 2× threshold), MEDIUM otherwise
- No mutations to input parameters

**Loop Invariants:**
- When iterating through priceHistory: all examined prices are within the time window

### Function 4: detectWhaleActivity()

```typescript
function detectWhaleActivity(
  trade: FilteredTrade,
  volatility: MarketVolatility | null,
  staticThresholdPercent: number,  // Fallback if volatility is null or insufficient samples
  zScoreThreshold: number          // Default: 3.0
): Anomaly | null
```

**Preconditions:**
- `trade` is a valid FilteredTrade object
- `trade.orderBookLiquidity` is a positive number
- `trade.sizeUSDC` is a positive number
- `staticThresholdPercent` is a positive number (typically 20)
- `zScoreThreshold` is a positive number (typically 3.0)

**Postconditions:**
- If `volatility !== null && volatility.sampleCount >= ZSCORE_MIN_SAMPLES`:
  - Calculates Z-score: `|trade.sizeUSDC - volatility.avgTradeSize| / volatility.stddevTradeSize`
  - Returns Anomaly if Z-score >= `zScoreThreshold`
  - `anomaly.confidence = Math.min(zScore / (zScoreThreshold * 2), 1.0)`
  - `anomaly.details.metrics` includes `zScore`, `avgTradeSize`, `stddevTradeSize`
- Else: falls back to static liquidity percentage threshold
- Returns null if liquidity data unavailable or threshold not met
- Anomaly.severity is HIGH if > 50% liquidity (or Z-score > 2× threshold), MEDIUM if > 20%, LOW otherwise
- No mutations to input parameters

**Loop Invariants:** N/A



### Function 5: detectInsiderTrading()

```typescript
async function detectInsiderTrading(
  trade: FilteredTrade,
  walletProfile: WalletProfile,
  thresholds: InsiderThresholds
): Promise<Anomaly | null>
```

**Preconditions:**
- `trade` is a valid FilteredTrade object
- `walletProfile` contains valid wallet analysis data
- `thresholds` contains insiderWalletAgeHours and insiderMinTradeSize
- `trade.marketCategory` is defined

**Postconditions:**
- Returns Anomaly with type 'INSIDER_TRADING' if all conditions met:
  - walletProfile.isNew === true (age < thresholdHours)
  - trade.sizeUSDC >= thresholds.insiderMinTradeSize
  - trade.marketCategory is in nicheMarketCategories
- Returns null if any condition is not met
- Anomaly.confidence is calculated from wallet age, trade size, and market category
- Anomaly.severity is HIGH if confidence > 0.8, MEDIUM if > 0.5
- No mutations to input parameters

**Loop Invariants:** N/A

### Function 6: analyzeWalletProfile()

```typescript
async function analyzeWalletProfile(
  address: string,
  alchemyApiKey: string,
  redisCache: RedisCache
): Promise<WalletProfile>
```

**Preconditions:**
- `address` is a valid Ethereum address (checksummed or lowercase)
- `alchemyApiKey` is a non-empty string
- `redisCache` is initialized and connected to Redis

**Postconditions:**
- Returns WalletProfile with complete wallet analysis
- If `redisCache.getWalletProfile(address)` returns non-null, returns cached value immediately (no API call)
- If wallet has no transactions: firstTransactionTimestamp and ageHours are null
- transactionCount is retrieved via `eth_getTransactionCount` RPC call
- firstTransactionTimestamp is retrieved via a single `alchemy_getAssetTransfers` call (fromBlock: "0x0", maxCount: 1, order: "asc")
- isNew is true if ageHours < 48 and transactionCount < 10
- riskScore is calculated based on age and activity patterns
- Profile is persisted to Redis via `redisCache.saveWalletProfile()` after fetch
- Falls back to Moralis `/{address}/verbose` endpoint if Alchemy call fails
- Throws ProviderError if both Alchemy and Moralis calls fail

**Loop Invariants:** N/A



### Function 7: formatTelegramAlert()

```typescript
function formatTelegramAlert(anomaly: Anomaly, trade: FilteredTrade): TelegramMessage
```

**Preconditions:**
- `anomaly` is a valid Anomaly object with type, severity, and details
- `trade` is a valid FilteredTrade object
- `trade.walletAddress` is a valid Ethereum address

**Postconditions:**
- Returns TelegramMessage with markdown-formatted text
- Message includes emoji indicator based on severity (🚨 HIGH, ⚠️ MEDIUM, ℹ️ LOW)
- Message contains market name, side, size in USDC with thousand separators
- Message includes clickable PolygonScan link for wallet
- Message includes clickable Polymarket market URL
- Message text length <= 4096 characters (Telegram limit)
- Special markdown characters are properly escaped
- No mutations to input parameters

**Loop Invariants:** N/A

### Function 8: exponentialBackoff()

```typescript
async function exponentialBackoff(
  attempt: number, 
  maxDelay: number
): Promise<void>
```

**Preconditions:**
- `attempt` is a non-negative integer representing retry attempt number
- `maxDelay` is a positive number representing maximum delay in milliseconds

**Postconditions:**
- Delays execution for calculated duration: min(2^attempt * 1000, maxDelay)
- For attempt 0: delays 1 second
- For attempt 1: delays 2 seconds
- For attempt 2: delays 4 seconds
- Delay never exceeds maxDelay
- Returns after delay completes

**Loop Invariants:** N/A



### Function 9: detectCluster()

```typescript
async function detectCluster(
  trade: FilteredTrade,
  timeSeriesDB: TimeSeriesDB,
  redisCache: RedisCache,
  blockchainAnalyzer: BlockchainAnalyzer,
  thresholds: DetectionThresholds
): Promise<ClusterAnomaly | null>
```

**Preconditions:**
- `trade` is a valid FilteredTrade with marketId, side, walletAddress, sizeUSDC, and timestamp
- `timeSeriesDB` is initialized and connected to TimescaleDB
- `redisCache` is initialized and connected to Redis
- `thresholds.clusterWindowMinutes` is a positive number (default: 10)
- `thresholds.clusterMinWallets` is an integer >= 2 (default: 3)

**Postconditions:**
- Calls `timeSeriesDB.recordClusterTrade(trade)` to persist the trade
- Queries `timeSeriesDB.getClusterWallets(marketId, side, windowStart)` for distinct wallets
- Returns null if distinct wallet count < `clusterMinWallets`
- If count >= `clusterMinWallets`: calls `blockchainAnalyzer.analyzeClusterFunding(wallets)`
- If `fundingAnalysis.hasCommonNonExchangeFunder === true`: sets severity to `CRITICAL` and attaches `fundingAnalysis`
- Else: severity is HIGH if wallet count >= 5, MEDIUM if >= 3
- `ClusterAnomaly.totalSizeUSDC` is the sum of all trades in the cluster window
- `ClusterAnomaly.wallets` contains all distinct wallet addresses in the cluster
- No mutations to input `trade` parameter

**Loop Invariants:** N/A

### Function 10: analyzeClusterFunding()

```typescript
async function analyzeClusterFunding(
  wallets: string[],
  alchemyApiKey: string,
  redisCache: RedisCache,
  knownExchangeWallets: Set<string>
): Promise<FundingAnalysis>
```

**Preconditions:**
- `wallets` is a non-empty array of valid Ethereum addresses
- `alchemyApiKey` is a non-empty string
- `redisCache` is initialized (used to cache funder lookups)
- `knownExchangeWallets` is a Set of known exchange hot wallet addresses

**Postconditions:**
- For each wallet, retrieves funder address: checks `HGET wallet:{address} funder` in Redis first; if miss, calls `alchemy_getAssetTransfers` with `maxCount: 1, order: "asc"` and caches result
- Builds `funders` map: wallet → funder address
- Builds `sharedFunders` map: funder → list of wallets it funded
- `hasCommonNonExchangeFunder` is true iff any funder funds >= 2 wallets AND is not in `knownExchangeWallets`
- `isKnownExchange` is true iff the shared funder is in `knownExchangeWallets`
- If Alchemy fails for a wallet, that wallet is omitted from the analysis (non-blocking)
- Returns complete `FundingAnalysis` regardless of individual wallet lookup failures

**Loop Invariants:**
- All previously processed wallets have their funder cached in Redis when loop continues

### Function 11: calculateZScore()

```typescript
function calculateZScore(
  value: number,
  mean: number,
  stddev: number
): number
```

**Preconditions:**
- `value` is a finite number
- `mean` is a finite number
- `stddev` is a positive number (> 0)

**Postconditions:**
- Returns `Math.abs(value - mean) / stddev`
- Result is always >= 0
- If `stddev === 0`, returns 0 (no variation in baseline — cannot flag anomaly)
- No side effects

**Loop Invariants:** N/A



## Algorithmic Pseudocode

### Ingestor Service Main Loop

```typescript
// src/ingestor/index.ts
async function startIngestor(): Promise<void> {
  const config = new ConfigManager()
  const logger = new Logger(config.get('LOG_LEVEL') || 'info')
  const redisCache = new RedisCache(config.getRedisUrl(), logger)
  const wsManager = new WebSocketManager(config.getPolymarketWSURL(), logger)
  
  await redisCache.connect()
  
  // Ensure consumer group exists
  await redisCache.createConsumerGroup('trades:stream', 'analyzers')
  
  wsManager.onTrade(async (rawTrade: RawTrade) => {
    // Normalize to NormalizedTrade (snake_case fields for Redis Stream)
    const normalized: NormalizedTrade = normalizeRawTrade(rawTrade)
    
    // Push to Redis Stream — NEVER block on downstream
    await redisCache.pushToStream('trades:stream', {
      market_id: normalized.market_id,
      market_name: normalized.market_name,
      side: normalized.side,
      price: String(normalized.price),
      size_usd: String(normalized.size_usd),
      timestamp: String(normalized.timestamp),
      maker_address: normalized.maker_address,
      taker_address: normalized.taker_address,
      bid_liquidity: String(normalized.bid_liquidity),
      ask_liquidity: String(normalized.ask_liquidity)
    })
  })
  
  wsManager.onError((error: Error) => {
    logger.error('WebSocket error', error)
  })
  
  await wsManager.connect()
  logger.info('Ingestor started')
  
  process.on('SIGINT', async () => {
    await wsManager.disconnect()
    await redisCache.disconnect()
    process.exit(0)
  })
}

startIngestor().catch(console.error)
```

**Preconditions:**
- Redis is running and accessible at `REDIS_URL`
- Polymarket WebSocket URL is configured

**Postconditions:**
- WebSocket connection is established
- Every incoming trade is pushed to `trades:stream` without blocking
- Process remains running until SIGINT

**Loop Invariants:**
- WebSocket connection is maintained or reconnecting
- Redis Stream push is fire-and-forget (never awaits downstream)

### Analyzer Service Main Loop

```typescript
// src/analyzer/index.ts
async function startAnalyzer(): Promise<void> {
  const config = new ConfigManager()
  const logger = new Logger(config.get('LOG_LEVEL') || 'info')
  const redisCache = new RedisCache(config.getRedisUrl(), logger)
  const timeSeriesDB = new TimeSeriesDB(config.getTimescaleDbUrl(), logger)
  const tradeFilter = new TradeFilter(config.getThresholds())
  const blockchainAnalyzer = new BlockchainAnalyzer(config.getAlchemyApiKey(), logger)
  const anomalyDetector = new AnomalyDetector(config.getThresholds(), blockchainAnalyzer, redisCache, timeSeriesDB, logger)
  const clusterDetector = new ClusterDetector(config.getThresholds(), timeSeriesDB, redisCache, blockchainAnalyzer, logger)
  const alertFormatter = new AlertFormatter()
  const telegramNotifier = new TelegramNotifier(config.getTelegramConfig(), logger)
  
  await redisCache.connect()
  await timeSeriesDB.connect()
  
  const telegramOk = await telegramNotifier.testConnection()
  if (!telegramOk) {
    logger.error('Failed to connect to Telegram')
    process.exit(1)
  }
  
  logger.info('Analyzer started — consuming from trades:stream')
  
  // Consumer loop
  while (true) {
    try {
      const messages = await redisCache.readFromStream(
        'trades:stream', 'analyzers', 'consumer1', 10
      )
      
      for (const msg of messages) {
        try {
          const rawTrade = deserializeStreamMessage(msg)
          const filteredTrade = tradeFilter.filter(rawTrade)
          
          if (!filteredTrade) {
            await redisCache.acknowledgeMessage('trades:stream', 'analyzers', msg.id)
            continue
          }
          
          // Cluster detection (async — includes funding analysis)
          const clusterAnomaly = await clusterDetector.detectCluster(filteredTrade)
          
          // Standard anomaly detection (Z-score with static fallback)
          const anomalies = await anomalyDetector.analyze(filteredTrade)
          
          const allAnomalies: (Anomaly | ClusterAnomaly)[] = [...anomalies]
          if (clusterAnomaly) allAnomalies.push(clusterAnomaly)
          
          for (const anomaly of allAnomalies) {
            const marketId = 'marketId' in anomaly ? anomaly.marketId : filteredTrade.marketId
            const walletKey = 'wallets' in anomaly ? anomaly.wallets[0] : filteredTrade.walletAddress
            
            const isDuplicate = await redisCache.hasAlertBeenSent(anomaly.type, marketId, walletKey)
            if (isDuplicate) continue
            
            const message = anomaly.type === 'COORDINATED_MOVE'
              ? alertFormatter.formatClusterAlert(anomaly as ClusterAnomaly)
              : alertFormatter.format(anomaly as Anomaly, filteredTrade)
            
            await telegramNotifier.sendAlert(message)
            await redisCache.recordSentAlert(
              anomaly.type, marketId, walletKey,
              config.get('ALERT_DEDUP_TTL_SECONDS') || 3600
            )
            logger.info('Alert sent', { type: anomaly.type, severity: anomaly.severity })
          }
          
          // Append price point to TimescaleDB for future Z-score baseline
          await timeSeriesDB.appendPricePoint(filteredTrade.marketId, filteredTrade.price, filteredTrade.timestamp)
          
          await redisCache.acknowledgeMessage('trades:stream', 'analyzers', msg.id)
          
        } catch (error) {
          logger.error('Error processing trade', error)
          // Still acknowledge to avoid infinite retry on bad messages
          await redisCache.acknowledgeMessage('trades:stream', 'analyzers', msg.id)
        }
      }
    } catch (error) {
      logger.error('Stream read error', error)
      await sleep(1000)  // Brief pause before retry
    }
  }
}

startAnalyzer().catch(console.error)
```

**Preconditions:**
- Redis and TimescaleDB are running and accessible
- Consumer group `analyzers` exists on `trades:stream`

**Postconditions:**
- Continuously reads from stream in batches of 10
- Every processed message is acknowledged with XACK
- Anomalies trigger Telegram alerts with Redis-based deduplication
- Price points are appended to TimescaleDB for Z-score baseline building

**Loop Invariants:**
- Every message is either processed and acknowledged, or acknowledged after error (no infinite retry on bad data)
- Redis deduplication prevents duplicate alerts within TTL window

### WebSocket Connection Algorithm with Exponential Backoff

```typescript
async function connectWithRetry(
  url: string, 
  options: ConnectionOptions, 
  maxRetries: number = Infinity
): Promise<WebSocket> {
  let attempt = 0
  
  while (attempt < maxRetries) {
    try {
      logger.info(`Connecting to WebSocket (attempt ${attempt + 1})`)
      
      const ws = new WebSocket(url, options)
      
      // Wait for connection to open
      await new Promise((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
        
        // Timeout after 30 seconds
        setTimeout(() => reject(new Error('Connection timeout')), 30000)
      })
      
      logger.info('WebSocket connected successfully')
      return ws
      
    } catch (error) {
      logger.warn(`Connection attempt ${attempt + 1} failed`, { error: error.message })
      
      if (attempt < maxRetries - 1) {
        // Calculate delay with exponential backoff
        const delay = Math.min(Math.pow(2, attempt) * 1000, 60000)
        logger.info(`Retrying in ${delay / 1000} seconds`)
        await sleep(delay)
      }
      
      attempt++
    }
  }
  
  throw new Error(`Failed to connect after ${maxRetries} attempts`)
}
```

**Preconditions:**
- `url` is a valid WebSocket URL
- `options` contains valid connection parameters
- `maxRetries` is a positive integer or Infinity

**Postconditions:**
- Returns connected WebSocket if successful within maxRetries
- Throws Error if all retry attempts fail
- Each retry uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, max 60s
- Connection timeout is 30 seconds per attempt

**Loop Invariants:**
- `attempt` is incremented after each failed connection
- Delay increases exponentially but never exceeds 60 seconds
- All previous connection attempts have failed when loop continues



### Z-Score Rapid Odds Shift Detection Algorithm

```typescript
function detectRapidOddsShift(
  trade: FilteredTrade,
  priceHistory: PricePoint[],
  volatility: MarketVolatility | null,
  staticThresholdPercent: number,
  zScoreThreshold: number
): Anomaly | null {
  const marketId = trade.marketId
  const currentPrice = trade.price
  const currentTime = trade.timestamp
  
  if (priceHistory.length === 0) return null
  
  const earliestPrice = priceHistory[0].price
  const priceChange = Math.abs(currentPrice - earliestPrice)
  const percentChange = (priceChange / earliestPrice) * 100
  
  let triggered = false
  let confidence = 0
  let zScore: number | null = null
  
  // Z-score path: use statistical baseline if available
  if (volatility && volatility.sampleCount >= ZSCORE_MIN_SAMPLES && volatility.stddevPriceChange > 0) {
    zScore = Math.abs(percentChange - volatility.avgPriceChange) / volatility.stddevPriceChange
    triggered = zScore >= zScoreThreshold
    confidence = Math.min(zScore / (zScoreThreshold * 2), 1.0)
  } else {
    // Static fallback for new markets
    triggered = percentChange >= staticThresholdPercent
    confidence = Math.min(percentChange / 50, 1.0)
  }
  
  if (!triggered) return null
  
  const severity = (zScore !== null ? zScore > zScoreThreshold * 2 : percentChange > 25) ? 'HIGH' : 'MEDIUM'
  
  return {
    type: 'RAPID_ODDS_SHIFT',
    severity,
    confidence,
    details: {
      description: `Price shifted ${percentChange.toFixed(1)}% (${zScore !== null ? `Z=${zScore.toFixed(2)}` : 'static threshold'})`,
      metrics: {
        oldPrice: earliestPrice,
        newPrice: currentPrice,
        percentChange,
        zScore,
        avgPriceChange: volatility?.avgPriceChange ?? null,
        stddevPriceChange: volatility?.stddevPriceChange ?? null,
        sampleCount: volatility?.sampleCount ?? 0
      }
    },
    detectedAt: currentTime
  }
}
```

**Preconditions:**
- `trade` is a valid FilteredTrade with price and timestamp
- `priceHistory` is sorted by timestamp ascending
- `staticThresholdPercent` is a positive number (typically 15)
- `zScoreThreshold` is a positive number (typically 3.0)

**Postconditions:**
- Uses Z-score when `volatility.sampleCount >= ZSCORE_MIN_SAMPLES`, static threshold otherwise
- Confidence and severity reflect the detection method used
- Anomaly metrics include Z-score and baseline stats for transparency
- No mutations to input parameters

**Loop Invariants:**
- When filtering priceHistory: all examined points are within the time window



### Z-Score Whale Activity Detection Algorithm

```typescript
function detectWhaleActivity(
  trade: FilteredTrade,
  volatility: MarketVolatility | null,
  staticThresholdPercent: number,
  zScoreThreshold: number
): Anomaly | null {
  const tradeSize = trade.sizeUSDC
  const liquidity = trade.orderBookLiquidity
  
  if (!liquidity || liquidity <= 0) return null
  
  let triggered = false
  let confidence = 0
  let zScore: number | null = null
  
  // Z-score path: compare trade size against market's normal distribution
  if (volatility && volatility.sampleCount >= ZSCORE_MIN_SAMPLES && volatility.stddevTradeSize > 0) {
    zScore = Math.abs(tradeSize - volatility.avgTradeSize) / volatility.stddevTradeSize
    triggered = zScore >= zScoreThreshold
    confidence = Math.min(zScore / (zScoreThreshold * 2), 1.0)
  } else {
    // Static fallback: percentage of order book liquidity consumed
    const liquidityPercent = (tradeSize / liquidity) * 100
    triggered = liquidityPercent >= staticThresholdPercent
    confidence = Math.min(liquidityPercent / 100, 1.0)
  }
  
  if (!triggered) return null
  
  const liquidityPercent = (tradeSize / liquidity) * 100
  let severity: 'LOW' | 'MEDIUM' | 'HIGH'
  if (zScore !== null ? zScore > zScoreThreshold * 2 : liquidityPercent > 50) {
    severity = 'HIGH'
  } else if (liquidityPercent > 20) {
    severity = 'MEDIUM'
  } else {
    severity = 'LOW'
  }
  
  return {
    type: 'WHALE_ACTIVITY',
    severity,
    confidence,
    details: {
      description: `Whale trade: $${tradeSize.toLocaleString()} USDC (${zScore !== null ? `Z=${zScore.toFixed(2)}` : `${liquidityPercent.toFixed(1)}% of liquidity`})`,
      metrics: {
        tradeSize,
        availableLiquidity: liquidity,
        percentConsumed: liquidityPercent,
        zScore,
        avgTradeSize: volatility?.avgTradeSize ?? null,
        stddevTradeSize: volatility?.stddevTradeSize ?? null,
        sampleCount: volatility?.sampleCount ?? 0
      }
    },
    detectedAt: trade.timestamp
  }
}
```

**Preconditions:**
- `trade` is a valid FilteredTrade with sizeUSDC and orderBookLiquidity
- `staticThresholdPercent` is a positive number (typically 20)
- `zScoreThreshold` is a positive number (typically 3.0)

**Postconditions:**
- Uses Z-score against market's trade size distribution when baseline is available
- Falls back to static liquidity percentage threshold for new markets
- Anomaly metrics include Z-score and baseline stats for transparency
- No mutations to input parameters

**Loop Invariants:** N/A



### Insider Trading Detection Algorithm

```typescript
async function detectInsiderTrading(
  trade: FilteredTrade,
  blockchainAnalyzer: BlockchainAnalyzer,
  thresholds: InsiderThresholds,
  redisCache: RedisCache
): Promise<Anomaly | null> {
  const walletAddress = trade.walletAddress
  
  // Check Redis cache first to avoid redundant API calls
  let walletProfile = await redisCache.getWalletProfile(walletAddress)
  
  if (!walletProfile) {
    // Query Alchemy indexer for wallet profile (single HTTP call)
    try {
      walletProfile = await blockchainAnalyzer.analyzeWalletProfile(walletAddress, redisCache)
    } catch (error) {
      logger.warn('Failed to analyze wallet', { address: walletAddress, error: error.message })
      return null  // Cannot determine without wallet data
    }
  }
  
  // Check insider trading conditions
  const isNewWallet = walletProfile.ageHours !== null && walletProfile.ageHours < thresholds.insiderWalletAgeHours
  const isLargeTrade = trade.sizeUSDC >= thresholds.insiderMinTradeSize
  const isNicheMarket = trade.marketCategory && thresholds.nicheMarketCategories.includes(trade.marketCategory)
  
  if (isNewWallet && isLargeTrade && isNicheMarket) {
    // Calculate confidence score
    const ageScore = 1 - (walletProfile.ageHours / thresholds.insiderWalletAgeHours)  // Newer = higher score
    const sizeScore = Math.min(trade.sizeUSDC / 50000, 1.0)  // Larger = higher score, cap at $50k
    const activityScore = walletProfile.transactionCount < 5 ? 1.0 : 0.5  // Very low activity = higher score
    
    const confidence = (ageScore * 0.4 + sizeScore * 0.3 + activityScore * 0.3)
    
    const severity = confidence > 0.8 ? 'HIGH' : confidence > 0.5 ? 'MEDIUM' : 'LOW'
    
    return {
      type: 'INSIDER_TRADING',
      severity,
      confidence,
      details: {
        description: `New wallet (${walletProfile.ageHours.toFixed(1)}h old) making large trade on niche market`,
        metrics: {
          walletAge: walletProfile.ageHours,
          transactionCount: walletProfile.transactionCount,
          tradeSize: trade.sizeUSDC,
          marketCategory: trade.marketCategory,
          riskScore: walletProfile.riskScore
        }
      },
      detectedAt: trade.timestamp
    }
  }
  
  return null
}
```

**Preconditions:**
- `trade` is a valid FilteredTrade with walletAddress, sizeUSDC, and marketCategory
- `blockchainAnalyzer` is initialized and connected to Alchemy API
- `thresholds` contains valid insider detection parameters
- `redisCache` is initialized for cache-first wallet lookup

**Postconditions:**
- Returns Anomaly if all three conditions are met: new wallet, large trade, niche market
- Returns null if any condition fails or wallet analysis fails
- Wallet profile is fetched from Redis cache or Alchemy API (never re-queried if cached)
- Confidence score is weighted combination of age, size, and activity scores
- Severity is HIGH if confidence > 0.8, MEDIUM if > 0.5, LOW otherwise
- No mutations to input parameters

**Loop Invariants:** N/A



### Cluster Detection with Funding Graph Analysis

```typescript
async function detectCluster(
  trade: FilteredTrade,
  timeSeriesDB: TimeSeriesDB,
  redisCache: RedisCache,
  blockchainAnalyzer: BlockchainAnalyzer,
  thresholds: DetectionThresholds
): Promise<ClusterAnomaly | null> {
  const { marketId, side, walletAddress, sizeUSDC, timestamp } = trade
  
  // Persist this trade to the cluster_trades hypertable
  await timeSeriesDB.recordClusterTrade(trade)
  
  // Define the lookback window
  const windowStart = new Date(timestamp.getTime() - thresholds.clusterWindowMinutes * 60 * 1000)
  
  // Query distinct wallets trading the same side on the same market within the window
  const wallets = await timeSeriesDB.getClusterWallets(marketId, side, windowStart)
  
  if (wallets.length < thresholds.clusterMinWallets) {
    return null  // Not enough distinct wallets
  }
  
  const totalSizeUSDC = await timeSeriesDB.getClusterTotalSize(marketId, side, windowStart)
  
  // Run funding graph analysis
  const fundingAnalysis = await blockchainAnalyzer.analyzeClusterFunding(wallets)
  
  // Upgrade to CRITICAL if common non-exchange funder found
  let severity: 'MEDIUM' | 'HIGH' | 'CRITICAL'
  if (fundingAnalysis.hasCommonNonExchangeFunder) {
    severity = 'CRITICAL'
  } else if (wallets.length >= 5) {
    severity = 'HIGH'
  } else {
    severity = 'MEDIUM'
  }
  
  return {
    type: 'COORDINATED_MOVE',
    marketId,
    marketName: trade.marketName,
    side,
    wallets,
    totalSizeUSDC,
    windowMinutes: thresholds.clusterWindowMinutes,
    detectedAt: timestamp,
    severity,
    ...(severity === 'CRITICAL' ? { fundingAnalysis } : {})
  }
}
```

**Preconditions:**
- `trade` is a valid FilteredTrade with all required fields
- `timeSeriesDB` is initialized and connected to TimescaleDB
- `thresholds.clusterWindowMinutes` is a positive number
- `thresholds.clusterMinWallets` is an integer >= 2

**Postconditions:**
- Trade is always persisted to `cluster_trades` hypertable regardless of whether a cluster is detected
- Returns `ClusterAnomaly` if distinct wallet count >= `clusterMinWallets` within the window
- Returns null if distinct wallet count < `clusterMinWallets`
- Funding analysis is always run when a cluster is detected
- Severity is CRITICAL if `fundingAnalysis.hasCommonNonExchangeFunder`, HIGH if >= 5 wallets, MEDIUM otherwise
- No mutations to input `trade` parameter

**Loop Invariants:** N/A

### Funding Graph Analysis Algorithm

```typescript
async function analyzeClusterFunding(
  wallets: string[],
  alchemyApiKey: string,
  redisCache: RedisCache,
  knownExchangeWallets: Set<string>
): Promise<FundingAnalysis> {
  const funders = new Map<string, string>()       // wallet -> funder
  const sharedFunders = new Map<string, string[]>() // funder -> wallets
  
  // For each wallet, get its funder (Redis-cached)
  for (const wallet of wallets) {
    try {
      // Check Redis cache first: HGET wallet:{address} funder
      let funder = await redisCache.getWalletFunder(wallet)
      
      if (!funder) {
        // Single Alchemy call: first inbound transaction's 'from' address
        const response = await alchemyGetAssetTransfers({
          toAddress: wallet,
          fromBlock: '0x0',
          maxCount: 1,
          order: 'asc',
          category: ['external', 'internal', 'erc20']
        })
        
        if (response.transfers.length > 0) {
          funder = response.transfers[0].from
          // Cache in Redis: HSET wallet:{address} funder {funderAddress}
          await redisCache.cacheWalletFunder(wallet, funder)
        }
      }
      
      if (funder) {
        funders.set(wallet, funder)
        const existing = sharedFunders.get(funder) || []
        existing.push(wallet)
        sharedFunders.set(funder, existing)
      }
    } catch (error) {
      // Non-blocking: skip this wallet if lookup fails
      logger.warn('Failed to get funder for wallet', { wallet, error: error.message })
    }
  }
  
  // Find common non-exchange funders (fund >= 2 wallets)
  let commonFunderAddress: string | null = null
  let isKnownExchange = false
  let exchangeName: string | null = null
  
  for (const [funder, fundedWallets] of sharedFunders.entries()) {
    if (fundedWallets.length >= 2) {
      if (knownExchangeWallets.has(funder.toLowerCase())) {
        isKnownExchange = true
        exchangeName = getExchangeName(funder)  // e.g., "Binance", "Coinbase"
      } else {
        commonFunderAddress = funder
        break  // First non-exchange common funder found
      }
    }
  }
  
  return {
    wallets,
    funders,
    sharedFunders,
    hasCommonNonExchangeFunder: commonFunderAddress !== null,
    commonFunderAddress,
    isKnownExchange,
    exchangeName
  }
}
```

**Preconditions:**
- `wallets` is a non-empty array of valid Ethereum addresses
- `redisCache` is initialized and connected
- `knownExchangeWallets` contains lowercase addresses of known exchange hot wallets

**Postconditions:**
- For each wallet, funder is retrieved from Redis cache or Alchemy (1 call per uncached wallet)
- Funder addresses are cached in Redis after first lookup
- `hasCommonNonExchangeFunder` is true iff a non-exchange address funds >= 2 cluster wallets
- Individual wallet lookup failures are non-blocking (wallet is skipped, not retried)
- Returns complete `FundingAnalysis` regardless of partial failures

**Loop Invariants:**
- All previously processed wallets have their funder cached in Redis when loop continues

### Insider Trading Detection Algorithm

```typescript
async function analyzeWalletProfile(
  address: string,
  alchemyApiKey: string,
  redisCache: RedisCache
): Promise<WalletProfile> {
  // Cache-first: return immediately if already known
  const cached = await redisCache.getWalletProfile(address)
  if (cached) return cached
  
  // Get transaction count via standard RPC
  const txCountHex = await alchemyRpc(alchemyApiKey, 'eth_getTransactionCount', [address, 'latest'])
  const transactionCount = parseInt(txCountHex, 16)
  
  if (transactionCount === 0) {
    const profile: WalletProfile = { address, firstTransactionTimestamp: null, transactionCount: 0, ageHours: null, isNew: true, riskScore: 100 }
    await redisCache.saveWalletProfile(profile)
    return profile
  }
  
  let firstTxTimestamp: number | null = null
  
  try {
    const result = await alchemyRpc(alchemyApiKey, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toAddress: address, maxCount: '0x1', order: 'asc',
      category: ['external', 'internal', 'erc20']
    }])
    
    if (result?.transfers?.length > 0) {
      const blockNum = parseInt(result.transfers[0].blockNum, 16)
      const block = await alchemyRpc(alchemyApiKey, 'eth_getBlockByNumber', [`0x${blockNum.toString(16)}`, false])
      firstTxTimestamp = parseInt(block.timestamp, 16)
    }
  } catch (error) {
    try {
      const moralisData = await moralisFetch(address)
      if (moralisData?.result?.length > 0) {
        firstTxTimestamp = new Date(moralisData.result[0].block_timestamp).getTime() / 1000
      }
    } catch {
      firstTxTimestamp = Date.now() / 1000 - (365 * 24 * 60 * 60)  // Assume 1 year old
    }
  }
  
  const ageHours = firstTxTimestamp ? (Date.now() / 1000 - firstTxTimestamp) / 3600 : null
  const isNew = ageHours !== null && ageHours < 48 && transactionCount < 10
  
  let riskScore = 0
  if (ageHours !== null) {
    if (ageHours < 24) riskScore += 40
    else if (ageHours < 48) riskScore += 30
    else if (ageHours < 168) riskScore += 20
  }
  if (transactionCount < 5) riskScore += 40
  else if (transactionCount < 10) riskScore += 30
  else if (transactionCount < 50) riskScore += 20
  
  const profile: WalletProfile = { address, firstTransactionTimestamp: firstTxTimestamp, transactionCount, ageHours, isNew, riskScore }
  await redisCache.saveWalletProfile(profile)
  return profile
}
```

**Preconditions:**
- `address` is a valid Ethereum address
- `alchemyApiKey` is a non-empty string with valid Alchemy credentials
- `redisCache` is initialized and connected to Redis

**Postconditions:**
- Returns cached WalletProfile immediately if found in Redis (0 API calls)
- If not cached: calls `alchemy_getAssetTransfers` with `maxCount: 1, order: "asc"` — O(1) API calls regardless of wallet age
- Falls back to Moralis if Alchemy fails; falls back to assuming 1-year-old wallet if both fail
- Profile is persisted to Redis before returning

**Loop Invariants:** N/A



## Example Usage

### Example 1: Ingestor Startup

```typescript
// src/ingestor/index.ts — run as polymarket-ingestor PM2 process
import { ConfigManager } from '../config/ConfigManager'
import { Logger } from '../utils/Logger'
import { RedisCache } from '../cache/RedisCache'
import { WebSocketManager } from '../websocket/WebSocketManager'

async function main() {
  const config = new ConfigManager()
  const logger = new Logger(config.get('LOG_LEVEL') || 'info')
  const redisCache = new RedisCache(config.getRedisUrl(), logger)
  const wsManager = new WebSocketManager(config.get('POLYMARKET_WS_URL'), logger)
  
  await redisCache.connect()
  await redisCache.createConsumerGroup('trades:stream', 'analyzers')
  
  wsManager.onTrade(async (rawTrade) => {
    const normalized = normalizeRawTrade(rawTrade)
    await redisCache.pushToStream('trades:stream', toStreamFields(normalized))
  })
  
  await wsManager.connect()
  logger.info('Ingestor running')
}

main().catch(console.error)
```

### Example 2: Analyzer Startup

```typescript
// src/analyzer/index.ts — run as polymarket-analyzer PM2 process
import { ConfigManager } from '../config/ConfigManager'
import { Logger } from '../utils/Logger'
import { RedisCache } from '../cache/RedisCache'
import { TimeSeriesDB } from '../db/TimeSeriesDB'
import { TradeFilter } from '../filters/TradeFilter'
import { AnomalyDetector } from '../detectors/AnomalyDetector'
import { ClusterDetector } from '../detectors/ClusterDetector'
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer'
import { AlertFormatter } from '../alerts/AlertFormatter'
import { TelegramNotifier } from '../notifications/TelegramNotifier'

async function main() {
  const config = new ConfigManager()
  const logger = new Logger(config.get('LOG_LEVEL') || 'info')
  const redisCache = new RedisCache(config.getRedisUrl(), logger)
  const timeSeriesDB = new TimeSeriesDB(config.getTimescaleDbUrl(), logger)
  const blockchainAnalyzer = new BlockchainAnalyzer(config.getAlchemyApiKey(), logger)
  const anomalyDetector = new AnomalyDetector(config.getThresholds(), blockchainAnalyzer, redisCache, timeSeriesDB, logger)
  const clusterDetector = new ClusterDetector(config.getThresholds(), timeSeriesDB, redisCache, blockchainAnalyzer, logger)
  const alertFormatter = new AlertFormatter()
  const telegramNotifier = new TelegramNotifier(config.getTelegramConfig(), logger)
  
  await redisCache.connect()
  await timeSeriesDB.connect()
  
  logger.info('Analyzer running — consuming from trades:stream')
  // Consumer loop handled by startAnalyzer() — see Algorithmic Pseudocode section
}

main().catch(console.error)
```

### Example 3: Configuration File (.env)

```bash
# Polymarket API
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market

# Alchemy Indexer API
ALCHEMY_API_KEY=your_alchemy_api_key_here

# Moralis fallback (optional)
MORALIS_API_KEY=your_moralis_api_key_here

# Redis (stream + cache)
REDIS_URL=redis://localhost:6379

# TimescaleDB (time-series persistence)
TIMESCALEDB_URL=postgresql://user:password@localhost:5432/polymarket

# Alert deduplication TTLs
ALERT_DEDUP_TTL_SECONDS=3600
CLUSTER_DEDUP_TTL_SECONDS=600

# Telegram
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=-1001234567890

# Detection Thresholds (static fallbacks)
MIN_TRADE_SIZE_USDC=5000
RAPID_ODDS_SHIFT_PERCENT=15
RAPID_ODDS_SHIFT_WINDOW_MINUTES=5
WHALE_ACTIVITY_PERCENT=20
INSIDER_WALLET_AGE_HOURS=48
INSIDER_MIN_TRADE_SIZE=10000
NICHE_MARKET_CATEGORIES=sports,crypto

# Cluster Detection
CLUSTER_WINDOW_MINUTES=10
CLUSTER_MIN_WALLETS=3

# Z-Score Detection
ZSCORE_THRESHOLD=3.0
ZSCORE_MIN_SAMPLES=30
ZSCORE_BASELINE_WINDOW=100

# Known exchange hot wallets (comma-separated, for funding analysis)
KNOWN_EXCHANGE_WALLETS=0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE,0x71660c4005BA85c37ccec55d0C4493E66Fe775d3,0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2

# Logging
LOG_LEVEL=info
LOG_FILE_PATH=./logs/bot.log
```

### Example 4: PM2 Ecosystem Configuration

```javascript
// ecosystem.config.js — two separate PM2 processes
module.exports = {
  apps: [
    {
      name: 'polymarket-ingestor',
      script: './dist/ingestor/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/ingestor-error.log',
      out_file: './logs/ingestor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      restart_delay: 5000
    },
    {
      name: 'polymarket-analyzer',
      script: './dist/analyzer/index.js',
      instances: 1,  // Scale to multiple for horizontal consumer scaling
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/analyzer-error.log',
      out_file: './logs/analyzer-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      restart_delay: 5000
    }
  ]
}
```



### Example 5: Telegram Alert Output — Insider Trading

```
🚨 HIGH SEVERITY ALERT

Type: Insider Trading Detected
Market: "Will Bitcoin reach $100k by Dec 31?"
Side: YES
Size: $15,000 USDC

Details:
New wallet (12.3h old) making large trade on niche market
Z-Score: 4.2 (baseline: 100 samples)

Wallet Metrics:
• Age: 12.3 hours
• Transaction Count: 2
• Risk Score: 85/100
• Confidence: 87%

Links:
🔗 Wallet: https://polygonscan.com/address/0x1234...5678
📊 Market: https://polymarket.com/event/bitcoin-100k

Detected: 2024-01-15 14:23:45 UTC
```

### Example 6: Coordinated Move Alert — CRITICAL (Common Funder)

```
� CRITICAL SEVERITY ALERT

Type: Coordinated Move — Common Funder Detected
Market: "Will the Fed cut rates in March?"
Side: YES
Wallets: 4 distinct wallets
Total Size: $62,000 USDC
Window: 10 minutes

Common Funder: 0xabcd...1234 (NOT a known exchange)
🔗 Funder: https://polygonscan.com/address/0xabcd...1234

Funded Wallets:
🔗 0xaaaa...1111 (funded by 0xabcd...1234)
🔗 0xbbbb...2222 (funded by 0xabcd...1234)
🔗 0xcccc...3333 (funded by 0xabcd...1234)
🔗 0xdddd...4444 (funded by 0xabcd...1234)

📊 Market: https://polymarket.com/event/fed-rate-march

Detected: 2024-01-15 14:31:02 UTC
```

### Example 7: Ubuntu VPS Deployment Commands

```bash
# 1. Install Node.js and PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Clone and setup project
git clone <repository-url> polymarket-bot
cd polymarket-bot
npm install
npm run build

# 3. Start Redis and TimescaleDB (Docker Compose — see Deployment section)
docker compose up -d redis timescaledb

# 4. Configure environment
cp .env.example .env
nano .env  # Edit with your credentials

# 5. Start both PM2 processes
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow instructions to enable auto-start on boot

# 6. Monitor logs
pm2 logs polymarket-ingestor
pm2 logs polymarket-analyzer

# 7. Check status
pm2 status

# 8. Restart if needed
pm2 restart polymarket-ingestor
pm2 restart polymarket-analyzer
```



## Correctness Properties

### Property 1: Trade Filtering Consistency

*For any* raw trade and threshold value, `filterTrade(trade, threshold)` returns non-null if and only if `trade.size_usd >= threshold`.

**Validates: Requirements 2.1, 2.2**

### Property 2: Anomaly Detection Completeness

*For any* filtered trade with known anomalous characteristics, `analyze(trade)` returns all applicable anomalies from `{RAPID_ODDS_SHIFT, WHALE_ACTIVITY, INSIDER_TRADING}`.

**Validates: Requirements 3.1, 4.1, 5.6**

### Property 3: WebSocket Reconnection Guarantee

*For any* disconnection event, the Ingestor attempts reconnection with exponential backoff delays of 1s, 2s, 4s, 8s, 16s, 32s, capped at 60s, until successful or process termination.

**Validates: Requirements 1.5, 1.6**

### Property 4: Alert Delivery Idempotency

*For any* detected anomaly, exactly one Telegram alert is sent within the deduplication TTL window — no duplicates, no missed alerts.

**Validates: Requirements 9.1, 9.2, 9.3**

### Property 5: Stream Delivery Guarantee

*For any* trade pushed to `trades:stream` by the Ingestor, the Analyzer eventually reads and acknowledges it via XACK under normal operation.

**Validates: Requirements 12.2, 12.3**

### Property 6: Wallet Profile Caching Correctness

*For any* wallet address, `analyzeWalletProfile` makes at most one Alchemy API call per address; all subsequent lookups return the Redis-cached value without any API call.

**Validates: Requirements 5.1, 5.3, 13.2**

### Property 7: Confidence Score Bounds

*For any* anomaly produced by the Anomaly_Detector, `0 ≤ anomaly.confidence ≤ 1`.

**Validates: Requirements 15.3**

### Property 8: Telegram Message Length Compliance

*For any* anomaly and trade combination, the formatted Telegram message text length is ≤ 4096 characters.

**Validates: Requirements 10.7**

### Property 9: Graceful Degradation on RPC Failure

*For any* Alchemy API failure, the Analyzer continues detecting rapid odds shifts and whale activity using static thresholds without crashing.

**Validates: Requirements 16.1**

### Property 10: Monotonic Timestamp Ordering

*For any* consecutive trades in `priceHistory`, `trade[i].timestamp ≤ trade[i+1].timestamp`.

**Validates: Requirements 8.1, 8.6**

### Property 11: Redis Persistence Across Restarts

*For any* wallet profile saved to Redis before process termination, `RedisCache.getWalletProfile()` returns the same profile after client reconnection without triggering any Alchemy API call.

**Validates: Requirements 13.1, 13.2**

### Property 12: Cluster Detection Threshold Monotonicity

*For any* set of trades and two threshold values `t1 ≤ t2`, the number of clusters detected with threshold `t2` is ≤ the number detected with threshold `t1`.

**Validates: Requirements 6.3, 6.4**

### Property 13: Cluster Wallet Distinctness

*For any* `ClusterAnomaly`, all wallet addresses in `anomaly.wallets` are distinct — the same wallet trading multiple times within the window is counted only once.

**Validates: Requirements 6.8**

### Property 14: Alert Deduplication via Redis TTL

*For any* sent alert, `RedisCache.hasAlertBeenSent()` returns `true` for the same anomaly type, market, and wallet until the TTL expires, and `false` after TTL expiry.

**Validates: Requirements 9.3, 9.4**

### Property 15: Z-Score Baseline Accuracy

*For any* market with `sampleCount >= ZSCORE_MIN_SAMPLES` and a known mean and stddev, anomalies are triggered at exactly `ZSCORE_THRESHOLD` sigma deviations and not below.

**Validates: Requirements 3.1, 4.1, 8.3**

### Property 16: Z-Score Static Fallback

*For any* market with `sampleCount < ZSCORE_MIN_SAMPLES` or null volatility, `detectRapidOddsShift` and `detectWhaleActivity` use static percentage thresholds exclusively.

**Validates: Requirements 3.2, 4.2, 8.4**

### Property 17: CRITICAL Severity Upgrade Conditions

*For any* `ClusterAnomaly`, `severity === 'CRITICAL'` if and only if `fundingAnalysis.hasCommonNonExchangeFunder === true`.

**Validates: Requirements 6.5, 6.6**

### Property 18: Funding Analysis Non-Blocking

*For any* set of cluster wallets where individual funder lookups fail, `analyzeClusterFunding` returns a complete `FundingAnalysis` object (does not throw) with failed wallets omitted from the analysis.

**Validates: Requirements 7.5, 7.6, 7.7**



## Error Handling

### Error Scenario 1: WebSocket Connection Failure

**Condition**: Initial connection to Polymarket WebSocket fails or connection drops during operation

**Response**: 
- Log error with details (error message, attempt number)
- Implement exponential backoff retry strategy
- Delay increases: 1s → 2s → 4s → 8s → 16s → 32s → 60s (max)
- Continue retry attempts indefinitely until successful

**Recovery**:
- On successful reconnection, resume normal operation
- Send Telegram notification: "Bot reconnected after [duration]"
- No data loss for trades occurring during downtime (WebSocket will catch up)

### Error Scenario 2: Telegram API Failure

**Condition**: Telegram Bot API returns error or times out when sending alert

**Response**:
- Log error with alert details and error message
- Retry sending with exponential backoff (max 3 attempts)
- If all retries fail, log alert to file system as backup
- Continue monitoring (don't crash the bot)

**Recovery**:
- On next successful Telegram send, include note about missed alerts
- Operator can review log files for missed alerts
- Consider implementing alert queue for retry on next successful connection

### Error Scenario 3: Polygon RPC Rate Limiting

**Condition**: Polygon RPC endpoint returns 429 (Too Many Requests) or times out

**Response**:
- Implement request rate limiting (max 10 requests/second)
- Use wallet profile cache to minimize redundant queries
- On rate limit error, wait 5 seconds before retry
- If RPC consistently fails, skip insider detection but continue other anomaly types

**Recovery**:
- Log warning about degraded functionality
- Send Telegram notification: "Insider detection temporarily disabled due to RPC issues"
- Automatically resume when RPC becomes available



### Error Scenario 4: Invalid Trade Data

**Condition**: WebSocket receives malformed trade data (missing fields, invalid types)

**Response**:
- Log warning with raw trade data for debugging
- Skip processing this trade
- Continue monitoring subsequent trades
- Increment error counter metric

**Recovery**:
- No recovery needed (isolated error)
- If error rate exceeds threshold (e.g., 10% of trades), send alert to operator
- May indicate API schema change requiring code update

### Error Scenario 5: Memory Exhaustion

**Condition**: Price history or wallet cache grows too large, approaching memory limits

**Response**:
- Implement automatic pruning of old price history data (keep only last 10 minutes)
- Implement LRU cache for wallet profiles (max 10,000 entries)
- PM2 configured to restart if memory exceeds 500MB
- Log warning when memory usage exceeds 400MB

**Recovery**:
- On PM2 restart, bot automatically reconnects and resumes
- Cache is rebuilt as new trades are processed
- No manual intervention required

### Error Scenario 6: Configuration Validation Failure

**Condition**: Required environment variables missing or invalid on startup

**Response**:
- Log detailed error message indicating which configuration is invalid
- Print example of correct configuration format
- Exit process with error code 1 (fail fast)
- Do not attempt to run with invalid configuration

**Recovery**:
- Operator must fix configuration and restart
- PM2 will not auto-restart on configuration errors (exit code 1)
- Prevents bot from running in misconfigured state



### Error Scenario 7: Alchemy API Failure

**Condition**: Alchemy `alchemy_getAssetTransfers` call returns an error, times out, or returns an unexpected response

**Response**:
- Log warning with wallet address and error details
- Attempt fallback to Moralis Web3 API `/{address}/verbose` endpoint
- If Moralis also fails, assume wallet is 1 year old (conservative fallback — avoids false insider alerts)
- Continue processing the trade with degraded wallet profiling
- Do not crash the bot

**Recovery**:
- Log warning: "Wallet profiling degraded — using fallback age assumption"
- On next trade from the same wallet, retry Alchemy (no permanent blacklisting)
- If Alchemy fails consistently (>10 consecutive failures), send Telegram notification: "Alchemy API degraded — insider detection using fallback"

### Error Scenario 8: Redis Connection Failure

**Condition**: Redis is unreachable at startup or drops connection during operation

**Response**:
- Ingestor: cannot push to stream — log error, implement retry with exponential backoff; do NOT drop WebSocket frames silently
- Analyzer: cannot read from stream — pause consumer loop, retry connection with backoff
- Alert deduplication: on Redis miss (cache unavailable), fall back to in-memory dedup map for the current session (may send duplicate alerts across restarts)
- Wallet profile cache: on Redis miss, proceed with Alchemy API call (degraded performance, not failure)

**Recovery**:
- On Redis reconnect, resume normal operation automatically (ioredis handles reconnection)
- Send Telegram notification: "Redis connection restored — stream processing resumed"
- Stream messages are durable in Redis — no data loss if Analyzer was paused

### Error Scenario 9: TimescaleDB Connection Failure

**Condition**: TimescaleDB is unreachable at startup or drops connection during operation

**Response**:
- `appendPricePoint()` failures: log warning, skip the write (price history may be incomplete)
- `getMarketVolatility()` failures: return null — triggers static threshold fallback in anomaly detection
- `recordClusterTrade()` failures: log warning, skip the write (cluster detection may miss this trade)
- `getClusterWallets()` failures: return empty array — cluster detection returns null (no false positives)
- Never crash the Analyzer due to TimescaleDB write failure

**Recovery**:
- On reconnect, normal operation resumes automatically (pg connection pool handles reconnection)
- Log warning: "TimescaleDB unavailable — Z-score detection using static thresholds"
- Send Telegram notification if failures persist for > 5 minutes

### Error Scenario 10: Stream Consumer Lag (Backpressure)

**Condition**: Analyzer falls behind — stream depth grows because Ingestor pushes faster than Analyzer processes

**Response**:
- Monitor stream depth via `RedisCache.getStreamDepth('trades:stream')` on a 30-second interval
- Log warning when depth > 10,000 messages
- Stream is capped at `MAXLEN ~ 100,000` — oldest messages are trimmed automatically by Redis
- If depth consistently > 50,000: send Telegram notification: "Stream backpressure — consider scaling Analyzer instances"

**Recovery**:
- Scale Analyzer horizontally: add more PM2 instances (each gets unique consumer name in the `analyzers` group)
- Redis consumer groups distribute messages across multiple Analyzer instances automatically
- No manual intervention required for temporary spikes

### Error Scenario 11: Funding Analysis API Failure

**Condition**: Alchemy call fails for one or more wallets during `analyzeClusterFunding()`

**Response**:
- Non-blocking: skip the failed wallet, continue with remaining wallets
- Log warning with wallet address and error details
- If ALL wallet funder lookups fail: return `FundingAnalysis` with `hasCommonNonExchangeFunder: false`
- Do NOT block or delay the cluster alert — degrade to HIGH severity instead of CRITICAL
- Send the cluster alert at HIGH severity with a note: "Funding analysis unavailable"

**Recovery**:
- On next cluster detection involving the same wallets, retry funder lookups (no permanent blacklisting)
- Cached funder addresses in Redis prevent redundant retries for wallets already resolved



## Testing Strategy

### Unit Testing Approach

**Framework**: Jest with TypeScript support

**Coverage Goals**: Minimum 80% code coverage for core logic

**Key Test Suites**:

1. **Trade Filter Tests**
   - Test threshold boundary conditions (exactly at threshold, just below, just above)
   - Test with various trade sizes (small, medium, large)
   - Test with invalid/malformed trade data
   - Verify no mutations to input data

2. **Anomaly Detection Tests**
   - Test rapid odds shift detection with various price movements
   - Test whale detection with different liquidity ratios
   - Test insider detection with various wallet profiles
   - Test edge cases (empty price history, missing data)
   - Verify confidence score calculations
   - Verify severity level assignments

3. **Blockchain Analyzer Tests**
   - Mock Alchemy API responses (fetch mock)
   - Test wallet age calculation from `alchemy_getAssetTransfers` response
   - Test transaction count retrieval via `eth_getTransactionCount`
   - Test cache-first behavior: verify no API call when Redis has the profile
   - Test Moralis fallback when Alchemy fails
   - Test conservative fallback (1-year-old assumption) when both APIs fail
   - Test error handling for network failures

4. **Alert Formatter Tests**
   - Test message formatting for each anomaly type
   - Test emoji selection based on severity
   - Test URL generation (PolygonScan, Polymarket)
   - Test message length compliance (≤4096 chars)
   - Test markdown escaping

5. **Configuration Manager Tests**
   - Test loading from environment variables
   - Test default value fallbacks
   - Test validation of required fields
   - Test type conversions (string to number, CSV to array)

6. **RedisCache Tests**
   - Test wallet profile save and retrieve round-trip (HSET/HGET)
   - Test alert deduplication: `hasAlertBeenSent` returns false before recording, true after, false after TTL expiry
   - Test cluster alert deduplication with TTL
   - Test stream push (`XADD`) and read (`XREADGROUP`) round-trip
   - Test `acknowledgeMessage` (XACK) removes message from pending
   - Test `getStreamDepth` returns correct XLEN value
   - Test persistence across RedisCache re-initialization (simulated restart)

7. **TimeSeriesDB Tests**
   - Test `appendPricePoint` inserts into hypertable
   - Test `getPriceHistory` returns only records within time window
   - Test `getMarketVolatility` returns correct mean/stddev from continuous aggregate
   - Test `recordClusterTrade` and `getClusterWallets` with multiple wallets
   - Test `getClusterTotalSize` sums correctly
   - Test behavior when TimescaleDB is unavailable (returns null/empty gracefully)

8. **ClusterDetector Tests**
   - Test no cluster returned when wallet count < clusterMinWallets
   - Test cluster returned when wallet count >= clusterMinWallets
   - Test same wallet trading multiple times counts as 1 distinct wallet
   - Test trades outside the time window are excluded
   - Test severity: CRITICAL when common non-exchange funder found, HIGH for >= 5 wallets, MEDIUM for 3-4
   - Test `fundingAnalysis` is attached when severity is CRITICAL
   - Test funding analysis failure degrades to HIGH (non-blocking)

9. **Z-Score Detection Tests**
   - Test `calculateZScore` returns correct value for known inputs
   - Test `calculateZScore` returns 0 when stddev is 0
   - Test `detectRapidOddsShift` uses Z-score when sampleCount >= ZSCORE_MIN_SAMPLES
   - Test `detectRapidOddsShift` falls back to static threshold when sampleCount < ZSCORE_MIN_SAMPLES
   - Test `detectWhaleActivity` uses Z-score when baseline available
   - Test confidence score is `Math.min(zScore / (zScoreThreshold * 2), 1.0)`

10. **FundingAnalysis Tests**
    - Test `analyzeClusterFunding` correctly identifies shared funders
    - Test known exchange wallets are not flagged as common funders
    - Test `hasCommonNonExchangeFunder` is false when funder is a known exchange
    - Test Redis caching of funder addresses (no duplicate Alchemy calls)
    - Test partial failure: one wallet lookup fails, others succeed



### Property-Based Testing Approach

**Framework**: fast-check (JavaScript/TypeScript property-based testing library)

**Property Test Library**: fast-check

**Key Properties to Test**:

1. **Trade Filtering Monotonicity**
   ```typescript
   // Property: Increasing threshold should never increase filtered trades
   fc.assert(
     fc.property(
       fc.array(arbitraryTrade()),
       fc.nat(100000),
       fc.nat(100000),
       (trades, threshold1, threshold2) => {
         fc.pre(threshold1 <= threshold2)
         const filtered1 = trades.filter(t => filterTrade(t, threshold1))
         const filtered2 = trades.filter(t => filterTrade(t, threshold2))
         return filtered2.length <= filtered1.length
       }
     )
   )
   ```

2. **Confidence Score Bounds**
   ```typescript
   // Property: All confidence scores must be in [0, 1]
   fc.assert(
     fc.property(
       arbitraryFilteredTrade(),
       async (trade) => {
         const anomalies = await detector.analyze(trade)
         return anomalies.every(a => a.confidence >= 0 && a.confidence <= 1)
       }
     )
   )
   ```

3. **Price History Window Correctness**
   ```typescript
   // Property: All prices in window are within time range
   fc.assert(
     fc.property(
       fc.array(arbitraryPricePoint()),
       fc.nat(60),
       (prices, windowMinutes) => {
         const now = new Date()
         const windowStart = new Date(now.getTime() - windowMinutes * 60000)
         const filtered = filterPriceWindow(prices, windowStart, now)
         return filtered.every(p => p.timestamp >= windowStart && p.timestamp <= now)
       }
     )
   )
   ```

4. **Exponential Backoff Growth**
   ```typescript
   // Property: Each retry delay should be approximately double the previous
   fc.assert(
     fc.property(
       fc.nat(10),
       (attempt) => {
         const delay1 = calculateBackoffDelay(attempt)
         const delay2 = calculateBackoffDelay(attempt + 1)
         return delay2 >= delay1 && delay2 <= Math.min(delay1 * 2, 60000)
       }
     )
   )
   ```

5. **Cluster Wallet Distinctness**
   ```typescript
   // Property: Cluster wallets array never contains duplicates
   fc.assert(
     fc.property(
       fc.array(arbitraryFilteredTrade(), { minLength: 3, maxLength: 20 }),
       (trades) => {
         // Feed all trades from same market/side to cluster detector
         const anomaly = detectClusterFromTrades(trades)
         if (!anomaly) return true
         const unique = new Set(anomaly.wallets)
         return unique.size === anomaly.wallets.length
       }
     )
   )
   ```

6. **Cluster Threshold Monotonicity**
   ```typescript
   // Property: Higher minWallets threshold never produces more clusters
   fc.assert(
     fc.property(
       fc.array(arbitraryFilteredTrade(), { minLength: 1, maxLength: 50 }),
       fc.integer({ min: 2, max: 5 }),
       fc.integer({ min: 2, max: 5 }),
       (trades, threshold1, threshold2) => {
         fc.pre(threshold1 <= threshold2)
         const clusters1 = countClusters(trades, threshold1)
         const clusters2 = countClusters(trades, threshold2)
         return clusters2 <= clusters1
       }
     )
   )
   ```



### Integration Testing Approach

**Framework**: Jest with test containers for external dependencies

**Key Integration Tests**:

1. **WebSocket Connection Lifecycle**
   - Test connection establishment to mock WebSocket server
   - Test automatic reconnection on disconnect
   - Test exponential backoff timing
   - Test message parsing and event emission
   - Verify graceful shutdown

2. **End-to-End Trade Processing**
   - Mock Polymarket WebSocket with sample trade data
   - Mock Polygon RPC with wallet data
   - Mock Telegram API
   - Verify complete flow: trade received → filtered → analyzed → alert sent
   - Verify correct anomaly detection for known scenarios

3. **Blockchain Integration**
   - Use Polygon testnet or mock RPC endpoint
   - Test wallet profile retrieval
   - Test rate limiting behavior
   - Test error handling for network failures
   - Verify caching reduces RPC calls

4. **Telegram Integration**
   - Use Telegram Bot API test environment
   - Test message sending with various formats
   - Test retry logic on failures
   - Test rate limiting compliance
   - Verify delivery confirmations

5. **PM2 Process Management**
   - Test bot startup with PM2
   - Test automatic restart on crash
   - Test memory limit enforcement
   - Test log rotation
   - Test graceful shutdown on SIGINT/SIGTERM

**Test Data**: Use recorded real trade data from Polymarket (anonymized) to ensure realistic testing scenarios.



## Performance Considerations

### WebSocket Message Throughput

**Requirement**: Handle high-frequency trade data during market volatility (estimated 100-500 trades/second peak)

**Optimization Strategies**:
- Use asynchronous processing for all I/O operations
- Implement non-blocking trade analysis pipeline
- Process trades in parallel where possible (independent market analysis)
- Use efficient data structures (Map for O(1) lookups, circular buffer for price history)

**Metrics to Monitor**:
- Message processing latency (target: <100ms per trade)
- Queue depth (if messages arrive faster than processing)
- Memory usage (should remain stable under load)

### Blockchain Query Optimization

**Challenge**: Indexer API calls to Alchemy can take 200-500ms and are rate-limited on free tiers

**Optimization Strategies**:
- Redis cache-first: `RedisCache.getWalletProfile()` is an async O(1) HGET — zero API calls for known wallets
- `alchemy_getAssetTransfers` with `maxCount: 1` returns the first transaction in a single HTTP call
- Funder addresses cached in Redis: `HGET wallet:{address} funder` — no duplicate Alchemy calls for funding analysis
- Implement request rate limiting (max 5 req/sec) to stay within Alchemy free tier
- Moralis fallback only triggered on Alchemy failure — not on every request

**Metrics to Monitor**:
- Alchemy API call latency (p50, p95, p99)
- Redis cache hit rate (target: >90% after warm-up period)
- Alchemy API error rate (should be <1%)

### Redis Stream Performance

**Challenge**: High-frequency trade ingestion must not block on downstream processing

**Optimization Strategies**:
- Ingestor uses fire-and-forget `XADD` — never awaits Analyzer processing
- Stream capped at `MAXLEN ~ 100,000` to prevent unbounded memory growth
- Analyzer reads in batches of 10 (`COUNT 10`) to amortize overhead
- Multiple Analyzer instances can consume in parallel via consumer groups
- `XACK` is called after processing to remove messages from the pending list

**Metrics to Monitor**:
- Stream depth (`XLEN trades:stream`) — alert if > 10,000
- Consumer lag (pending message count per consumer)
- XADD latency (should be <1ms on local Redis)

### TimescaleDB Performance

**Challenge**: Time-series inserts and rolling-window queries must be non-blocking

**Optimization Strategies**:
- Async inserts via `pg` connection pool — never stalls the Node.js event loop
- TimescaleDB hypertables automatically partition by time — range queries are O(partitions) not O(total rows)
- Continuous aggregate `market_volatility_1h` pre-computes mean/stddev — `getMarketVolatility()` is a fast materialized view scan
- Indexes on `(market_id, time DESC)` for efficient per-market queries
- TimescaleDB automatic data retention policies can be configured to drop old partitions

**Metrics to Monitor**:
- Insert latency per operation
- `getMarketVolatility()` query time (should be <10ms with continuous aggregate)
- Database size growth rate

### Memory Management

**Challenge**: In-memory state must remain bounded across both services

**Optimization Strategies**:
- Price history and wallet cache are stored in Redis/TimescaleDB, not in-memory Maps — memory footprint is bounded
- Ingestor only holds the WebSocket connection and a Redis client — very low memory footprint (target: <128MB)
- Analyzer holds detection state and connection pools — target: <256MB
- PM2 memory limits: Ingestor 256MB, Analyzer 500MB with automatic restart as safety net
- Redis stream capped at `MAXLEN ~ 100,000` — prevents unbounded stream growth

**Metrics to Monitor**:
- Heap memory usage per service
- Redis memory usage (`INFO memory`)
- TimescaleDB database size
- Garbage collection frequency and duration



### Alert Delivery Performance

**Challenge**: Telegram API has rate limits (30 messages/second) and network latency

**Optimization Strategies**:
- Implement alert queue with rate limiting
- Batch multiple anomalies for same trade into single message
- Use async/await to avoid blocking on Telegram API calls
- Implement retry with exponential backoff for failed sends
- Consider alert deduplication (don't send identical alerts within 1 minute)

**Metrics to Monitor**:
- Alert delivery latency (time from detection to Telegram send)
- Alert queue depth
- Telegram API error rate
- Alert deduplication rate

### CPU Efficiency

**Optimization Strategies**:
- Use efficient algorithms (binary search for wallet history, O(1) map lookups)
- Avoid unnecessary JSON parsing/serialization
- Use native JavaScript methods where possible
- Profile hot paths and optimize bottlenecks
- Consider using worker threads for CPU-intensive tasks if needed

**Metrics to Monitor**:
- CPU usage (should remain <50% under normal load)
- Event loop lag (should be <10ms)
- Function execution time for hot paths



## Security Considerations

### API Key Protection

**Threat**: Exposure of Telegram bot token or RPC API keys

**Mitigation**:
- Store all credentials in environment variables, never in code
- Use .env file for local development (add to .gitignore)
- Use secure secret management for production (AWS Secrets Manager, HashiCorp Vault)
- Rotate API keys periodically
- Implement least-privilege access (bot token should only have send message permission)

### Wallet Address Validation

**Threat**: Malicious data injection via invalid wallet addresses

**Mitigation**:
- Validate all wallet addresses using Ethers.js address validation
- Sanitize addresses before blockchain queries
- Use checksummed addresses for consistency
- Reject addresses that don't match Ethereum format (0x + 40 hex chars)

### Telegram Message Injection

**Threat**: Malicious trade data could inject markdown/HTML into Telegram messages

**Mitigation**:
- Escape all user-controlled data in Telegram messages
- Use markdown escaping for special characters: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`
- Validate market names and other string fields
- Limit message length to prevent abuse
- Use Telegram's parse_mode carefully

### RPC Endpoint Security

**Threat**: Exposure of private RPC endpoint or API key

**Mitigation**:
- Use environment variables for RPC URL
- Consider using public RPC endpoints for non-sensitive queries
- Implement rate limiting to avoid quota exhaustion
- Monitor for unusual RPC usage patterns
- Use HTTPS for all RPC connections



### Denial of Service Protection

**Threat**: Malicious actor floods WebSocket with fake trades to overwhelm bot

**Mitigation**:
- Implement trade filtering to reduce processing load
- Use efficient data structures and algorithms
- Set memory limits with PM2 (auto-restart on exhaustion)
- Monitor message rate and alert on anomalies
- Consider implementing circuit breaker pattern for external services

### Logging Security

**Threat**: Sensitive data (wallet addresses, trade details) in logs could be exposed

**Mitigation**:
- Implement log rotation to prevent unbounded log growth
- Set appropriate file permissions on log files (600 - owner read/write only)
- Consider log aggregation service with encryption (e.g., CloudWatch, Datadog)
- Avoid logging sensitive configuration (API keys, tokens)
- Implement log level controls (debug logs only in development)

### Process Isolation

**Threat**: Compromised bot process could affect other services on VPS

**Mitigation**:
- Run bot as non-root user with limited permissions
- Use PM2 to isolate process and enforce resource limits
- Consider containerization (Docker) for additional isolation
- Implement firewall rules to restrict network access
- Keep Node.js and dependencies updated for security patches



## Dependencies

### Core Dependencies

**Runtime Dependencies**:
- `ws` (^8.14.0) - WebSocket client for Polymarket CLOB API
- `ioredis` (^5.3.0) - Redis client for stream operations and caching
- `pg` (^8.11.0) - PostgreSQL/TimescaleDB client for time-series persistence
- `node-telegram-bot-api` (^0.64.0) - Telegram Bot API client
- `dotenv` (^16.3.1) - Environment variable management

**Development Dependencies**:
- `typescript` (^5.3.0) - TypeScript compiler
- `@types/node` (^20.10.0) - Node.js type definitions
- `@types/ws` (^8.5.0) - WebSocket type definitions
- `@types/pg` - PostgreSQL type definitions
- `jest` (^29.7.0) - Testing framework
- `ts-jest` (^29.1.0) - TypeScript support for Jest
- `fast-check` (^3.15.0) - Property-based testing library
- `eslint` (^8.55.0) - Code linting
- `prettier` (^3.1.0) - Code formatting

**Removed Dependencies**:
- `better-sqlite3` — replaced by Redis (cache/dedup) + TimescaleDB (time-series)
- `@types/better-sqlite3` — no longer needed
- `ethers` — not needed; wallet profiling uses Alchemy HTTP API directly via native `fetch`

### External Services

**Polymarket CLOB API**:
- WebSocket endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Documentation: https://docs.polymarket.com
- Rate limits: Not publicly documented (monitor for throttling)
- Authentication: Not required for public market data

**Alchemy Indexer API**:
- Endpoint: `https://polygon-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}`
- Key methods: `alchemy_getAssetTransfers` (wallet first TX + funder lookup), `eth_getTransactionCount`
- Parameters: `fromBlock: "0x0"`, `toAddress: address`, `maxCount: "0x1"`, `order: "asc"`, `category: ["external","internal","erc20"]`
- Documentation: https://docs.alchemy.com/reference/alchemy-getassettransfers
- Rate limits: 300 req/sec (Growth plan), 5 req/sec (Free plan)
- Authentication: API key in URL path

**Moralis Web3 API (Fallback)**:
- Endpoint: `https://deep-index.moralis.io/api/v2.2/{address}/verbose`
- Parameters: `chain=polygon&limit=1&order=ASC`
- Documentation: https://docs.moralis.io/web3-data-api/evm/reference/get-decoded-wallet-transaction
- Authentication: `X-API-Key` header
- Used only as fallback when Alchemy is unavailable

**Telegram Bot API**:
- Endpoint: https://api.telegram.org/bot{token}/
- Documentation: https://core.telegram.org/bots/api
- Rate limits: 30 messages/second per bot, 20 messages/minute per chat
- Authentication: Bot token in URL

**Redis**:
- Version: 7.x recommended
- Purpose: Trade stream (`trades:stream`), wallet profile cache, alert deduplication (TTL-native)
- Connection: `REDIS_URL` environment variable (default: `redis://localhost:6379`)
- Stream key: `trades:stream`; consumer group: `analyzers`; max length: `MAXLEN ~ 100,000`

**TimescaleDB**:
- Version: TimescaleDB 2.x on PostgreSQL 15+
- Purpose: Time-series price history, cluster trades, market volatility continuous aggregates
- Connection: `TIMESCALEDB_URL` environment variable
- Tables: `price_history` (hypertable), `cluster_trades` (hypertable), `market_volatility_1h` (continuous aggregate)

### Infrastructure Dependencies

**PM2**:
- Version: Latest stable (install globally with npm)
- Purpose: Process management, auto-restart, logging
- Configuration: ecosystem.config.js

**Node.js**:
- Version: 20.x LTS (recommended)
- Minimum: 18.x
- Features used: async/await, ES modules, native fetch (if used)

**Ubuntu VPS**:
- Version: 20.04 LTS or 22.04 LTS
- Minimum specs: 1 CPU, 1GB RAM, 10GB storage
- Recommended: 2 CPU, 2GB RAM, 20GB storage for production



## Deployment Architecture

### Production Deployment Topology

```mermaid
graph TB
    subgraph "Ubuntu VPS"
        PM2[PM2 Process Manager]
        Ingestor[polymarket-ingestor process]
        Analyzer[polymarket-analyzer process]
        Logs[Log Files]
        PM2 --> Ingestor
        PM2 --> Analyzer
        Ingestor --> Logs
        Analyzer --> Logs
    end
    
    subgraph "Infrastructure (Docker or managed)"
        Redis[Redis 7.x]
        TSDB[TimescaleDB / PostgreSQL 15+]
        Ingestor -->|XADD trades:stream| Redis
        Analyzer -->|XREADGROUP / XACK| Redis
        Analyzer -->|INSERT / SELECT| TSDB
    end
    
    subgraph "External Services"
        Polymarket[Polymarket CLOB WebSocket]
        Alchemy[Alchemy Indexer API]
        Telegram[Telegram Bot API]
    end
    
    Ingestor -->|WebSocket| Polymarket
    Analyzer -->|HTTPS| Alchemy
    Analyzer -->|HTTPS| Telegram
    
    User[Telegram User] -->|Receives Alerts| Telegram
```

### Docker Compose (Local Development)

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data

  timescaledb:
    image: timescale/timescaledb:latest-pg15
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: polymarket
    volumes:
      - tsdb_data:/var/lib/postgresql/data

volumes:
  redis_data:
  tsdb_data:
```

### File Structure

```
polymarket-bot/
├── src/
│   ├── ingestor/
│   │   └── index.ts                    # Ingestor service entry point (PM2: polymarket-ingestor)
│   ├── analyzer/
│   │   └── index.ts                    # Analyzer service entry point (PM2: polymarket-analyzer)
│   ├── config/
│   │   └── ConfigManager.ts            # Configuration management
│   ├── websocket/
│   │   └── WebSocketManager.ts         # WebSocket connection handling
│   ├── filters/
│   │   └── TradeFilter.ts              # Trade filtering logic
│   ├── detectors/
│   │   ├── AnomalyDetector.ts          # Z-score anomaly detection engine
│   │   └── ClusterDetector.ts          # Coordinated wallet cluster + funding analysis
│   ├── blockchain/
│   │   └── BlockchainAnalyzer.ts       # Alchemy API: wallet profiles + funding graph
│   ├── cache/
│   │   └── RedisCache.ts               # Redis: stream ops + wallet cache + alert dedup
│   ├── db/
│   │   └── TimeSeriesDB.ts             # TimescaleDB: price history + cluster trades
│   ├── alerts/
│   │   └── AlertFormatter.ts           # Telegram message formatting (incl. CRITICAL alerts)
│   ├── notifications/
│   │   └── TelegramNotifier.ts         # Telegram API client
│   ├── utils/
│   │   ├── Logger.ts                   # Logging utility
│   │   └── helpers.ts                  # Helper functions (calculateZScore, etc.)
│   └── types/
│       └── index.ts                    # TypeScript type definitions
├── tests/
│   ├── unit/                           # Unit tests
│   ├── integration/                    # Integration tests
│   └── property/                       # Property-based tests
├── logs/                               # Log files (gitignored)
├── dist/                               # Compiled JavaScript (gitignored)
├── .env                                # Environment variables (gitignored)
├── .env.example                        # Example environment file
├── docker-compose.yml                  # Local dev: Redis + TimescaleDB
├── ecosystem.config.js                 # PM2 configuration (two apps)
├── package.json                        # NPM dependencies
├── tsconfig.json                       # TypeScript configuration
├── jest.config.js                      # Jest test configuration
└── README.md                           # Documentation
```

### Operational Monitoring

**Key Metrics to Track**:
- Ingestor and Analyzer uptime and restart count
- WebSocket connection status (Ingestor)
- Redis stream depth (`XLEN trades:stream`) — backpressure indicator
- Consumer lag (pending messages per Analyzer instance)
- Trade processing rate (trades/second through Analyzer)
- Anomaly detection rate (anomalies/hour)
- Alert delivery success rate
- Alchemy API call latency and error rate
- TimescaleDB query latency
- Memory and CPU usage per service

**Monitoring Tools**:
- PM2 built-in monitoring: `pm2 monit`
- Redis monitoring: `redis-cli INFO stats`, `redis-cli XLEN trades:stream`
- TimescaleDB monitoring: `SELECT * FROM timescaledb_information.hypertables`
- Custom metrics logged to application logs
- Consider external monitoring (Datadog, New Relic, CloudWatch)
- Set up alerts for critical failures (service down, stream backpressure, high error rate)

