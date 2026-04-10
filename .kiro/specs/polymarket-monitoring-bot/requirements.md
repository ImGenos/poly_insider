# Requirements Document

## Introduction

The Polymarket Monitoring Bot is a production-ready microservice system that provides 24/7 real-time surveillance of the Polymarket prediction market platform. It ingests live trade data via WebSocket, filters noise, detects anomalous trading patterns (rapid odds shifts, whale activity, insider trading, and coordinated wallet clusters), and delivers rich Telegram alerts with severity levels and blockchain explorer links. The system is split into two decoupled services — an Ingestor and an Analyzer — connected via a Redis Stream, with TimescaleDB providing durable time-series storage for statistical baselines.

## Glossary

- **Ingestor**: The PM2 process (`polymarket-ingestor`) responsible for maintaining the WebSocket connection to Polymarket and pushing normalized trades to the Redis Stream.
- **Analyzer**: The PM2 process (`polymarket-analyzer`) responsible for consuming trades from the Redis Stream, running the full detection pipeline, and sending Telegram alerts.
- **Trade_Filter**: The component that rejects trades below the configured minimum size threshold.
- **Anomaly_Detector**: The component that runs rapid odds shift, whale activity, and insider trading detection algorithms.
- **Cluster_Detector**: The component that detects coordinated wallet activity and runs funding graph analysis.
- **Blockchain_Analyzer**: The component that queries the Alchemy Indexer API for wallet profiles and funding relationships.
- **Alert_Formatter**: The component that transforms anomaly data into rich Telegram messages.
- **Telegram_Notifier**: The component that delivers formatted alerts to the configured Telegram chat.
- **Redis_Cache**: The Redis-backed component providing wallet profile caching, alert deduplication, and stream operations.
- **Time_Series_DB**: The TimescaleDB-backed component providing durable time-series storage for price history and cluster trades.
- **Config_Manager**: The component that loads and validates all configuration from environment variables.
- **NormalizedTrade**: The canonical trade message format pushed to `trades:stream` with snake_case fields.
- **FilteredTrade**: A trade that has passed the minimum size threshold, with camelCase fields.
- **Anomaly**: A detected suspicious trading pattern with type, severity, confidence, and details.
- **ClusterAnomaly**: A detected coordinated wallet activity event with severity up to CRITICAL.
- **WalletProfile**: Cached wallet metadata including age, transaction count, and risk score.
- **MarketVolatility**: Rolling statistical baseline (mean, stddev, sample count) for a market's price changes and trade sizes.
- **FundingAnalysis**: The result of analyzing whether cluster wallets share a common non-exchange funder.
- **Z-score**: A statistical measure of how many standard deviations a value is from the mean of its baseline distribution.
- **ZSCORE_MIN_SAMPLES**: The minimum number of data points required before Z-score detection activates (default: 30).
- **ZSCORE_THRESHOLD**: The number of standard deviations required to trigger a Z-score anomaly (default: 3.0).

## Requirements

### Requirement 1: WebSocket Ingestion

**User Story:** As a system operator, I want the bot to maintain a continuous WebSocket connection to Polymarket's CLOB API, so that every live trade is captured in real time without gaps.

#### Acceptance Criteria

1. WHEN the Ingestor starts, THE Ingestor SHALL establish a WebSocket connection to the configured `POLYMARKET_WS_URL` endpoint.
2. WHEN a WebSocket connection is established, THE Ingestor SHALL register event listeners for `message`, `error`, and `close` events.
3. WHEN a raw trade message is received over WebSocket, THE Ingestor SHALL normalize it into a `NormalizedTrade` object with snake_case fields.
4. WHEN a `NormalizedTrade` is produced, THE Ingestor SHALL push it to the `trades:stream` Redis Stream via `XADD` without awaiting downstream processing.
5. WHEN the WebSocket connection drops or fails, THE Ingestor SHALL attempt reconnection using exponential backoff with delays of 1s, 2s, 4s, 8s, 16s, 32s, and a maximum of 60s per attempt.
6. WHEN a connection attempt times out after 30 seconds, THE Ingestor SHALL treat it as a failed attempt and apply the next backoff delay.
7. WHEN the Ingestor receives a `SIGINT` signal, THE Ingestor SHALL disconnect the WebSocket and close the Redis connection before exiting.

---

### Requirement 2: Trade Noise Filtering

**User Story:** As a system operator, I want trades below a configurable minimum size to be ignored, so that the detection pipeline only processes economically significant activity.

#### Acceptance Criteria

1. WHEN a `NormalizedTrade` is read from the stream, THE Trade_Filter SHALL return a `FilteredTrade` if and only if `size_usd >= MIN_TRADE_SIZE_USDC`.
2. WHEN `size_usd < MIN_TRADE_SIZE_USDC`, THE Trade_Filter SHALL return null and the trade SHALL be acknowledged and skipped.
3. WHEN a trade passes the filter, THE Trade_Filter SHALL produce a `FilteredTrade` with all field names normalized to camelCase.
4. THE Trade_Filter SHALL NOT mutate the input `NormalizedTrade` object.
5. THE Config_Manager SHALL expose `MIN_TRADE_SIZE_USDC` with a default value of 5000.

---

### Requirement 3: Rapid Odds Shift Detection

**User Story:** As a trader, I want to be alerted when a market's price moves abnormally fast, so that I can investigate potential information leakage or manipulation.

#### Acceptance Criteria

1. WHEN a `FilteredTrade` is analyzed and `MarketVolatility.sampleCount >= ZSCORE_MIN_SAMPLES`, THE Anomaly_Detector SHALL compute the Z-score of the current price change against the market's rolling baseline and flag the trade if the Z-score >= `ZSCORE_THRESHOLD`.
2. WHEN a `FilteredTrade` is analyzed and `MarketVolatility.sampleCount < ZSCORE_MIN_SAMPLES` or volatility data is unavailable, THE Anomaly_Detector SHALL flag the trade if the percentage price change within the configured window >= `RAPID_ODDS_SHIFT_PERCENT` (default: 15%).
3. WHEN a rapid odds shift anomaly is detected via Z-score and the Z-score > 2 × `ZSCORE_THRESHOLD`, THE Anomaly_Detector SHALL assign severity `HIGH`; otherwise THE Anomaly_Detector SHALL assign severity `MEDIUM`.
4. WHEN a rapid odds shift anomaly is detected via static threshold and the price change > 25%, THE Anomaly_Detector SHALL assign severity `HIGH`; otherwise THE Anomaly_Detector SHALL assign severity `MEDIUM`.
5. WHEN a rapid odds shift anomaly is produced, THE Anomaly_Detector SHALL set `anomaly.confidence = Math.min(zScore / (ZSCORE_THRESHOLD * 2), 1.0)` for Z-score detections, or a proportional value for static detections.
6. WHEN price history for a market is empty, THE Anomaly_Detector SHALL return null for rapid odds shift detection.
7. THE Anomaly_Detector SHALL NOT mutate input parameters during rapid odds shift detection.

---

### Requirement 4: Whale Activity Detection

**User Story:** As a trader, I want to be alerted when an unusually large trade is placed relative to a market's normal activity, so that I can track significant capital movements.

#### Acceptance Criteria

1. WHEN a `FilteredTrade` is analyzed and `MarketVolatility.sampleCount >= ZSCORE_MIN_SAMPLES`, THE Anomaly_Detector SHALL compute the Z-score of `sizeUSDC` against the market's rolling trade size distribution and flag the trade if the Z-score >= `ZSCORE_THRESHOLD`.
2. WHEN a `FilteredTrade` is analyzed and `MarketVolatility.sampleCount < ZSCORE_MIN_SAMPLES` or volatility data is unavailable, THE Anomaly_Detector SHALL flag the trade if `(sizeUSDC / orderBookLiquidity) * 100 >= WHALE_ACTIVITY_PERCENT` (default: 20%).
3. WHEN `orderBookLiquidity` is zero or unavailable, THE Anomaly_Detector SHALL return null for whale activity detection.
4. WHEN a whale anomaly is detected via Z-score and the Z-score > 2 × `ZSCORE_THRESHOLD`, THE Anomaly_Detector SHALL assign severity `HIGH`.
5. WHEN a whale anomaly is detected via static threshold and liquidity consumed > 50%, THE Anomaly_Detector SHALL assign severity `HIGH`; WHEN liquidity consumed > 20%, THE Anomaly_Detector SHALL assign severity `MEDIUM`; otherwise THE Anomaly_Detector SHALL assign severity `LOW`.
6. WHEN a whale anomaly is produced, THE Anomaly_Detector SHALL set `anomaly.confidence = Math.min(zScore / (ZSCORE_THRESHOLD * 2), 1.0)` for Z-score detections.
7. THE Anomaly_Detector SHALL NOT mutate input parameters during whale activity detection.

---

### Requirement 5: Insider Trading Detection

**User Story:** As a trader, I want to be alerted when a brand-new wallet makes a large trade on a niche market, so that I can identify potential information advantages.

#### Acceptance Criteria

1. WHEN a `FilteredTrade` is analyzed, THE Anomaly_Detector SHALL retrieve the `WalletProfile` for `trade.walletAddress` from `Redis_Cache` before making any external API call.
2. IF the `WalletProfile` is not in `Redis_Cache`, THEN THE Blockchain_Analyzer SHALL call `alchemy_getAssetTransfers` with `fromBlock: "0x0"`, `toAddress: address`, `maxCount: 1`, `order: "asc"` to retrieve the wallet's first transaction in a single HTTP call.
3. WHEN a `WalletProfile` is fetched from the Alchemy API, THE Blockchain_Analyzer SHALL persist it to `Redis_Cache` before returning.
4. IF the Alchemy API call fails, THEN THE Blockchain_Analyzer SHALL attempt the Moralis `/{address}/verbose` endpoint as a fallback.
5. IF both Alchemy and Moralis fail, THEN THE Blockchain_Analyzer SHALL assume the wallet is 1 year old and continue processing without throwing.
6. WHEN a `WalletProfile` is available, THE Anomaly_Detector SHALL flag the trade as insider trading if and only if all three conditions are met: `walletProfile.ageHours < INSIDER_WALLET_AGE_HOURS` (default: 48), `trade.sizeUSDC >= INSIDER_MIN_TRADE_SIZE` (default: 10000), and `trade.marketCategory` is in `NICHE_MARKET_CATEGORIES`.
7. WHEN an insider trading anomaly is produced, THE Anomaly_Detector SHALL calculate confidence as a weighted combination: age score × 0.4 + size score × 0.3 + activity score × 0.3.
8. WHEN insider trading confidence > 0.8, THE Anomaly_Detector SHALL assign severity `HIGH`; WHEN confidence > 0.5, THE Anomaly_Detector SHALL assign severity `MEDIUM`; otherwise THE Anomaly_Detector SHALL assign severity `LOW`.
9. THE Anomaly_Detector SHALL NOT mutate input parameters during insider trading detection.

---

### Requirement 6: Coordinated Wallet Cluster Detection

**User Story:** As a trader, I want to be alerted when multiple distinct wallets coordinate trades on the same market side within a short window, so that I can identify potential market manipulation.

#### Acceptance Criteria

1. WHEN a `FilteredTrade` is processed by the Cluster_Detector, THE Cluster_Detector SHALL persist the trade to the `cluster_trades` hypertable via `Time_Series_DB.recordClusterTrade()` regardless of whether a cluster is subsequently detected.
2. WHEN a trade is recorded, THE Cluster_Detector SHALL query `Time_Series_DB.getClusterWallets()` for distinct wallet addresses trading the same `marketId` and `side` within the last `CLUSTER_WINDOW_MINUTES` (default: 10).
3. IF the distinct wallet count < `CLUSTER_MIN_WALLETS` (default: 3), THEN THE Cluster_Detector SHALL return null.
4. IF the distinct wallet count >= `CLUSTER_MIN_WALLETS`, THEN THE Cluster_Detector SHALL call `Blockchain_Analyzer.analyzeClusterFunding()` with the list of distinct wallets.
5. WHEN `FundingAnalysis.hasCommonNonExchangeFunder === true`, THE Cluster_Detector SHALL set `ClusterAnomaly.severity = 'CRITICAL'` and attach the `FundingAnalysis` to the anomaly.
6. WHEN no common non-exchange funder is found and wallet count >= 5, THE Cluster_Detector SHALL set severity `HIGH`; WHEN wallet count >= 3, THE Cluster_Detector SHALL set severity `MEDIUM`.
7. THE Cluster_Detector SHALL deduplicate cluster alerts via `Redis_Cache.hasClusterAlertBeenSent()` to prevent re-alerting on the same market/side within the deduplication TTL.
8. THE `ClusterAnomaly.wallets` array SHALL contain only distinct wallet addresses.
9. THE Cluster_Detector SHALL NOT mutate the input `FilteredTrade` parameter.

---

### Requirement 7: Funding Graph Analysis

**User Story:** As a trader, I want cluster alerts to include information about whether the coordinated wallets share a common funding source, so that I can assess the likelihood of deliberate coordination.

#### Acceptance Criteria

1. WHEN `analyzeClusterFunding()` is called, THE Blockchain_Analyzer SHALL check `Redis_Cache` for a cached funder address (`HGET wallet:{address} funder`) before calling the Alchemy API for each wallet.
2. WHEN a funder address is retrieved from the Alchemy API, THE Blockchain_Analyzer SHALL cache it in Redis (`HSET wallet:{address} funder {funderAddress}`) before continuing.
3. WHEN a funder address funds >= 2 cluster wallets and is not in the `KNOWN_EXCHANGE_WALLETS` list, THE Blockchain_Analyzer SHALL set `FundingAnalysis.hasCommonNonExchangeFunder = true` and populate `commonFunderAddress`.
4. WHEN the shared funder is in the `KNOWN_EXCHANGE_WALLETS` list, THE Blockchain_Analyzer SHALL set `FundingAnalysis.isKnownExchange = true` and populate `exchangeName`, but SHALL NOT set `hasCommonNonExchangeFunder = true`.
5. IF the Alchemy API call fails for an individual wallet, THEN THE Blockchain_Analyzer SHALL skip that wallet and continue processing the remaining wallets without throwing.
6. IF all wallet funder lookups fail, THEN THE Blockchain_Analyzer SHALL return a `FundingAnalysis` with `hasCommonNonExchangeFunder = false` rather than throwing.
7. THE Blockchain_Analyzer SHALL NOT block or delay the cluster alert when funding analysis encounters partial failures.

---

### Requirement 8: Statistical Baseline Management

**User Story:** As a system operator, I want the bot to build per-market statistical baselines from historical trade data, so that anomaly detection adapts to each market's volatility profile rather than using fixed thresholds.

#### Acceptance Criteria

1. WHEN a `FilteredTrade` is processed, THE Analyzer SHALL append a price point to the `price_history` hypertable via `Time_Series_DB.appendPricePoint()`.
2. WHEN `getMarketVolatility()` is called, THE Time_Series_DB SHALL query the `market_volatility_1h` continuous aggregate view and return a `MarketVolatility` object with `avgPriceChange`, `stddevPriceChange`, `avgTradeSize`, `stddevTradeSize`, and `sampleCount`.
3. WHEN `sampleCount >= ZSCORE_MIN_SAMPLES` (default: 30), THE Anomaly_Detector SHALL use Z-score detection for both rapid odds shift and whale activity.
4. WHEN `sampleCount < ZSCORE_MIN_SAMPLES`, THE Anomaly_Detector SHALL use static percentage thresholds as fallback.
5. WHEN `stddevPriceChange === 0` or `stddevTradeSize === 0`, THE Anomaly_Detector SHALL return 0 for the Z-score calculation and SHALL NOT flag an anomaly.
6. THE Time_Series_DB SHALL use the `price_history` hypertable partitioned by time with an index on `(market_id, time DESC)` for efficient per-market queries.
7. WHEN the Analyzer restarts, THE Time_Series_DB SHALL load existing volatility baselines from the continuous aggregate view without requiring a warm-up period.

---

### Requirement 9: Alert Deduplication

**User Story:** As a user, I want to receive each alert only once within a configurable time window, so that I am not spammed with repeated notifications for the same event.

#### Acceptance Criteria

1. WHEN an anomaly is detected, THE Analyzer SHALL check `Redis_Cache.hasAlertBeenSent(type, marketId, walletAddress)` before sending any Telegram alert.
2. IF `hasAlertBeenSent` returns true, THEN THE Analyzer SHALL skip sending the alert and continue processing.
3. WHEN an alert is sent successfully, THE Analyzer SHALL call `Redis_Cache.recordSentAlert(type, marketId, walletAddress, ALERT_DEDUP_TTL_SECONDS)` to set a TTL-native deduplication key.
4. THE Redis_Cache SHALL implement alert deduplication using `SETEX alert:{type}:{marketId}:{walletAddress} {ttlSeconds} 1` with no custom pruning logic.
5. THE Config_Manager SHALL expose `ALERT_DEDUP_TTL_SECONDS` with a default value of 3600.
6. THE Config_Manager SHALL expose `CLUSTER_DEDUP_TTL_SECONDS` with a default value of 600 for cluster alert deduplication.

---

### Requirement 10: Telegram Alert Formatting

**User Story:** As a user, I want Telegram alerts to be rich, readable, and actionable, so that I can quickly understand the anomaly and investigate further.

#### Acceptance Criteria

1. WHEN an anomaly is formatted, THE Alert_Formatter SHALL include a severity emoji: 🚨 for `HIGH` and `CRITICAL`, ⚠️ for `MEDIUM`, ℹ️ for `LOW`.
2. WHEN an anomaly is formatted, THE Alert_Formatter SHALL include the market name, trade side (YES/NO), and trade size in USDC with thousand separators.
3. WHEN an anomaly is formatted, THE Alert_Formatter SHALL include a clickable PolygonScan link for the wallet address (`https://polygonscan.com/address/{address}`).
4. WHEN an anomaly is formatted, THE Alert_Formatter SHALL include a clickable Polymarket market URL.
5. WHEN a `CRITICAL` cluster anomaly is formatted, THE Alert_Formatter SHALL include the common funder address, a PolygonScan link for the funder, and the list of funded wallet addresses with their PolygonScan links.
6. THE Alert_Formatter SHALL escape all special Markdown characters in user-controlled data fields (market names, wallet addresses) before including them in the message.
7. THE formatted message text SHALL NOT exceed 4096 characters (Telegram API limit).
8. THE Alert_Formatter SHALL set `parse_mode` to `'Markdown'` and `disable_web_page_preview` to `false`.

---

### Requirement 11: Telegram Alert Delivery

**User Story:** As a user, I want alerts to be reliably delivered to my Telegram chat, so that I never miss a significant market event.

#### Acceptance Criteria

1. WHEN an alert is ready to send, THE Telegram_Notifier SHALL authenticate with the Telegram Bot API using the configured `TELEGRAM_BOT_TOKEN` and send to `TELEGRAM_CHAT_ID`.
2. IF a Telegram API call fails, THEN THE Telegram_Notifier SHALL retry with exponential backoff for a maximum of 3 attempts before logging the failure and continuing.
3. THE Telegram_Notifier SHALL respect the Telegram rate limit of 30 messages per second.
4. WHEN the Analyzer starts, THE Telegram_Notifier SHALL call `testConnection()` and exit with code 1 if the connection test fails.
5. IF all retry attempts fail, THEN THE Telegram_Notifier SHALL log the alert details to the file system as a backup and SHALL NOT crash the Analyzer.

---

### Requirement 12: Redis Stream Operations

**User Story:** As a system operator, I want trades to flow reliably between the Ingestor and Analyzer via Redis Streams, so that no trade data is lost and backpressure is manageable.

#### Acceptance Criteria

1. THE Ingestor SHALL push trades to `trades:stream` using `XADD trades:stream MAXLEN ~ 100000 * {fields}`.
2. THE Analyzer SHALL consume trades from `trades:stream` using `XREADGROUP GROUP analyzers consumer1 COUNT 10 BLOCK 100`.
3. WHEN a trade message is successfully processed, THE Analyzer SHALL acknowledge it via `XACK trades:stream analyzers {id}`.
4. IF a trade message causes a processing error, THEN THE Analyzer SHALL still acknowledge it via `XACK` to prevent infinite redelivery.
5. THE Redis_Cache SHALL expose `getStreamDepth()` via `XLEN trades:stream` for backpressure monitoring.
6. WHEN stream depth exceeds 10,000 messages, THE Analyzer SHALL log a warning.
7. WHEN stream depth consistently exceeds 50,000 messages, THE Analyzer SHALL send a Telegram notification recommending horizontal scaling.
8. THE Redis Stream SHALL be capped at `MAXLEN ~ 100,000` entries to prevent unbounded memory growth.

---

### Requirement 13: State Persistence

**User Story:** As a system operator, I want wallet profiles and price history to survive process restarts, so that the bot does not lose its statistical baselines or re-query known wallets after a restart.

#### Acceptance Criteria

1. THE Redis_Cache SHALL store wallet profiles as Redis Hashes: `HSET wallet:{address} first_tx_timestamp {val} tx_count {val} age_hours {val} is_new {val} risk_score {val} funder {val}` with no TTL (permanent cache).
2. WHEN `Redis_Cache.getWalletProfile(address)` is called after a Redis client reconnection, THE Redis_Cache SHALL return the previously saved profile without making any Alchemy API call.
3. THE Time_Series_DB SHALL persist price history to the `price_history` hypertable and cluster trades to the `cluster_trades` hypertable, both partitioned by time.
4. WHEN the Analyzer restarts, THE Time_Series_DB SHALL serve existing volatility baselines from the `market_volatility_1h` continuous aggregate view immediately.

---

### Requirement 14: Configuration Management

**User Story:** As a system operator, I want all detection thresholds and service credentials to be configurable via environment variables, so that I can tune the bot without modifying code.

#### Acceptance Criteria

1. THE Config_Manager SHALL load all configuration from environment variables at startup.
2. THE Config_Manager SHALL provide the following defaults when environment variables are absent: `MIN_TRADE_SIZE_USDC=5000`, `RAPID_ODDS_SHIFT_PERCENT=15`, `RAPID_ODDS_SHIFT_WINDOW_MINUTES=5`, `WHALE_ACTIVITY_PERCENT=20`, `INSIDER_WALLET_AGE_HOURS=48`, `INSIDER_MIN_TRADE_SIZE=10000`, `CLUSTER_WINDOW_MINUTES=10`, `CLUSTER_MIN_WALLETS=3`, `ZSCORE_THRESHOLD=3.0`, `ZSCORE_MIN_SAMPLES=30`, `ZSCORE_BASELINE_WINDOW=100`.
3. THE Config_Manager SHALL parse `NICHE_MARKET_CATEGORIES` as a comma-separated list with default `sports,crypto`.
4. THE Config_Manager SHALL parse `KNOWN_EXCHANGE_WALLETS` as a comma-separated list of lowercase Ethereum addresses.
5. IF any required environment variable (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALCHEMY_API_KEY`, `REDIS_URL`, `TIMESCALEDB_URL`, `POLYMARKET_WS_URL`) is missing or empty, THEN THE Config_Manager SHALL log a descriptive error and exit the process with code 1.
6. THE Config_Manager SHALL validate that all numeric thresholds are positive and that `CLUSTER_MIN_WALLETS >= 2`.

---

### Requirement 15: Data Validation

**User Story:** As a system operator, I want all incoming trade data and wallet addresses to be validated, so that malformed data does not cause crashes or incorrect detections.

#### Acceptance Criteria

1. WHEN a raw trade message is received, THE Ingestor SHALL validate that `market_id` is a non-empty string, `side` is exactly `'YES'` or `'NO'`, `price` is between 0 and 1, `size_usd` is a positive number, `timestamp` is a valid Unix timestamp, and `maker_address` and `taker_address` match the Ethereum address format (`0x` followed by 40 hexadecimal characters).
2. IF a raw trade message fails validation, THEN THE Ingestor SHALL log a warning with the raw data and skip the message without crashing.
3. THE Anomaly_Detector SHALL validate that `anomaly.confidence` is always in the range [0, 1].
4. THE Anomaly_Detector SHALL validate that `anomaly.type` is one of `'RAPID_ODDS_SHIFT'`, `'WHALE_ACTIVITY'`, `'INSIDER_TRADING'`, or `'COORDINATED_MOVE'`.
5. THE Anomaly_Detector SHALL validate that `anomaly.severity` is one of `'LOW'`, `'MEDIUM'`, `'HIGH'`, or `'CRITICAL'`.

---

### Requirement 16: Error Handling and Graceful Degradation

**User Story:** As a system operator, I want the bot to continue monitoring even when individual components fail, so that partial outages do not cause complete loss of surveillance.

#### Acceptance Criteria

1. IF the Alchemy API is unavailable, THEN THE Analyzer SHALL continue detecting rapid odds shifts and whale activity using static thresholds, and SHALL log a warning that insider detection is degraded.
2. IF TimescaleDB is unavailable, THEN THE Anomaly_Detector SHALL fall back to static percentage thresholds for all detections, and THE Cluster_Detector SHALL return null (no false positives).
3. IF Redis is unavailable during stream operations, THEN THE Ingestor SHALL retry with exponential backoff and SHALL NOT silently drop WebSocket frames.
4. IF Redis is unavailable for alert deduplication, THEN THE Analyzer SHALL fall back to an in-memory deduplication map for the current session.
5. WHEN the error rate for malformed trade messages exceeds 10% of recent trades, THE Analyzer SHALL send a Telegram notification to the operator.
6. WHEN Alchemy fails for more than 10 consecutive wallet lookups, THE Analyzer SHALL send a Telegram notification: "Alchemy API degraded — insider detection using fallback".
7. WHEN TimescaleDB is unavailable for more than 5 minutes, THE Analyzer SHALL send a Telegram notification: "TimescaleDB unavailable — Z-score detection using static thresholds".

---

### Requirement 17: Process Management and Deployment

**User Story:** As a system operator, I want both services to run reliably under PM2 on an Ubuntu VPS with automatic restart and log management, so that the bot operates continuously without manual intervention.

#### Acceptance Criteria

1. THE Ingestor SHALL run as a PM2 process named `polymarket-ingestor` with `autorestart: true`, `max_memory_restart: '256M'`, and `restart_delay: 5000`.
2. THE Analyzer SHALL run as a PM2 process named `polymarket-analyzer` with `autorestart: true`, `max_memory_restart: '500M'`, and `restart_delay: 5000`.
3. THE system SHALL provide a `docker-compose.yml` that starts Redis 7.x and TimescaleDB (PostgreSQL 15+) as local infrastructure services with persistent volumes.
4. THE system SHALL provide an `ecosystem.config.js` PM2 configuration file defining both processes with separate error and output log files.
5. THE system SHALL provide a `.env.example` file documenting all required and optional environment variables.
6. WHEN a PM2 process exceeds its configured memory limit, PM2 SHALL automatically restart it.
7. THE system SHALL initialize the TimescaleDB schema (hypertables, indexes, continuous aggregate) on first startup if the tables do not exist.

---

### Requirement 18: Logging

**User Story:** As a system operator, I want structured, leveled logs from both services, so that I can diagnose issues and monitor system health.

#### Acceptance Criteria

1. THE Logger SHALL write logs to both the console and a configured log file path (`LOG_FILE_PATH`).
2. THE Logger SHALL include a timestamp and severity level (`info`, `warn`, `error`, `debug`) in every log entry.
3. THE Logger SHALL support structured metadata as JSON in log entries.
4. THE Logger SHALL rotate log files daily.
5. THE Logger SHALL NOT include API keys, bot tokens, or other credentials in any log entry.
6. THE Config_Manager SHALL expose `LOG_LEVEL` with a default of `'info'`.

---

### Requirement 19: Security

**User Story:** As a system operator, I want the bot to protect credentials and sanitize all external data, so that it is not vulnerable to injection attacks or credential exposure.

#### Acceptance Criteria

1. THE system SHALL store all credentials (`TELEGRAM_BOT_TOKEN`, `ALCHEMY_API_KEY`, `MORALIS_API_KEY`, `TIMESCALEDB_URL`) exclusively in environment variables and SHALL NOT hardcode them in source files.
2. THE Alert_Formatter SHALL escape all special Markdown characters (`_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`) in any user-controlled string field before including it in a Telegram message.
3. THE Blockchain_Analyzer SHALL validate all wallet addresses against the Ethereum address format (`0x` + 40 hex characters) before using them in API calls or Redis keys.
4. THE system SHALL run as a non-root user on the Ubuntu VPS.
5. THE system SHALL use HTTPS for all connections to external APIs (Alchemy, Moralis, Telegram).

---

### Requirement 20: Performance

**User Story:** As a system operator, I want the bot to handle peak trade volumes without falling behind, so that alerts are delivered in near real-time even during high-activity periods.

#### Acceptance Criteria

1. THE Ingestor SHALL process each incoming WebSocket trade message and push it to the Redis Stream within 100ms under normal load.
2. THE Analyzer SHALL process each trade from the stream (including all detection algorithms) within 500ms under normal load, excluding Alchemy API call latency.
3. THE Blockchain_Analyzer SHALL limit Alchemy API calls to a maximum of 5 requests per second to stay within free-tier rate limits.
4. THE Redis_Cache wallet profile cache hit rate SHALL exceed 90% after the warm-up period.
5. THE Time_Series_DB `getMarketVolatility()` query SHALL complete within 10ms when the `market_volatility_1h` continuous aggregate is available.
6. THE Ingestor process memory usage SHALL remain below 256MB under normal operation.
7. THE Analyzer process memory usage SHALL remain below 500MB under normal operation.
