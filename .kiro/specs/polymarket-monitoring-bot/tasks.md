# Implementation Plan: Polymarket Monitoring Bot

## Overview

Implement a production-ready TypeScript microservice system split into two PM2 processes (Ingestor + Analyzer) connected via Redis Streams, with TimescaleDB for time-series persistence and Z-score statistical anomaly detection. Tasks are ordered to build incrementally — each step integrates into the previous.

## Tasks

- [x] 1. Project scaffolding and configuration
  - Initialize `package.json` with all runtime deps: `ws`, `ioredis`, `pg`, `node-telegram-bot-api`, `dotenv`
  - Add dev deps: `typescript`, `@types/node`, `@types/ws`, `@types/pg`, `jest`, `ts-jest`, `fast-check`, `eslint`, `prettier`
  - Create `tsconfig.json` targeting ES2020, `outDir: ./dist`, `rootDir: ./src`, strict mode enabled
  - Create `jest.config.js` with `ts-jest` preset, `testMatch` covering `tests/**/*.test.ts`
  - Create directory structure: `src/{ingestor,analyzer,config,websocket,filters,detectors,blockchain,cache,db,alerts,notifications,utils,types}` and `tests/{unit,integration,property}`
  - Create `.env.example` documenting all required and optional env vars per Requirements 14.5, 17.5
  - _Requirements: 14.1, 17.4, 17.5_

- [x] 2. Core types and interfaces
  - [x] 2.1 Create `src/types/index.ts` with all TypeScript interfaces and types
    - Define `RawTrade`, `NormalizedTrade`, `FilteredTrade`, `Anomaly`, `ClusterAnomaly`
    - Define `WalletProfile`, `MarketVolatility`, `FundingAnalysis`, `PricePoint`
    - Define `DetectionThresholds`, `TelegramMessage`, `TelegramConfig`, `StreamMessage`
    - Define `InsiderThresholds`, `ConnectionOptions`, `LogLevel` union type
    - Ensure `Anomaly.type` union, `severity` union, and `ClusterAnomaly.severity` match design specs
    - _Requirements: 15.3, 15.4, 15.5_

- [x] 3. Configuration Manager
  - [x] 3.1 Implement `src/config/ConfigManager.ts`
    - Load all env vars at construction time using `dotenv`
    - Implement `getThresholds(): DetectionThresholds` returning all defaults per Requirements 14.2
    - Implement `getTelegramConfig()`, `getAlchemyApiKey()`, `getRedisUrl()`, `getTimescaleDbUrl()`
    - Parse `NICHE_MARKET_CATEGORIES` and `KNOWN_EXCHANGE_WALLETS` as comma-separated lists per Requirements 14.3, 14.4
    - Validate required vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALCHEMY_API_KEY`, `REDIS_URL`, `TIMESCALEDB_URL`, `POLYMARKET_WS_URL`) — exit with code 1 if missing per Requirements 14.5
    - Validate all numeric thresholds are positive and `CLUSTER_MIN_WALLETS >= 2` per Requirements 14.6
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x] 3.2 Write unit tests for ConfigManager
    - Test default values when env vars absent
    - Test CSV parsing for list fields
    - Test process exit on missing required vars
    - Test numeric validation
    - _Requirements: 14.2, 14.5, 14.6_

- [x] 4. Logger and utility helpers
  - [x] 4.1 Implement `src/utils/Logger.ts`
    - Write to console and file (`LOG_FILE_PATH` env var) with daily rotation
    - Include ISO timestamp and severity level in every entry per Requirements 18.2
    - Support structured metadata as JSON per Requirements 18.3
    - Redact API keys and tokens from log output per Requirements 18.5, 19.1
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [x] 4.2 Implement `src/utils/helpers.ts`
    - Implement `calculateZScore(value, mean, stddev): number` — returns 0 when stddev === 0 per design Function 11
    - Implement `exponentialBackoff(attempt, maxDelay): Promise<void>` — delays `min(2^attempt * 1000, maxDelay)` per design Function 8
    - Implement `sleep(ms): Promise<void>` utility
    - Implement `escapeMarkdown(text: string): string` escaping all Telegram special chars per Requirements 10.6, 19.2
    - Implement `isValidEthAddress(address: string): boolean` per Requirements 15.1, 19.3
    - _Requirements: 3.5, 8.5, 10.6, 19.2, 19.3_

  - [x] 4.3 Write property test for calculateZScore
    - **Property 7: Confidence Score Bounds** — for any inputs, result is always >= 0
    - **Property 15: Z-Score Baseline Accuracy** — for known mean/stddev, result equals `|value - mean| / stddev`
    - **Validates: Requirements 15.3, 3.1, 4.1, 8.3**

  - [x] 4.4 Write property test for exponentialBackoff
    - **Property 3: WebSocket Reconnection Guarantee** — each delay is double the previous, capped at maxDelay
    - **Validates: Requirements 1.5, 1.6**


- [x] 5. Redis Cache
  - [x] 5.1 Implement `src/cache/RedisCache.ts` using `ioredis`
    - Implement `connect()` / `disconnect()` with ioredis auto-reconnect
    - Implement `pushToStream(streamKey, fields)` using `XADD ... MAXLEN ~ 100000` per Requirements 12.1
    - Implement `createConsumerGroup(streamKey, group)` — idempotent, ignore BUSYGROUP error
    - Implement `readFromStream(streamKey, group, consumer, count)` using `XREADGROUP ... BLOCK 100` per Requirements 12.2
    - Implement `acknowledgeMessage(streamKey, group, messageId)` using `XACK` per Requirements 12.3
    - Implement `getStreamDepth(streamKey)` using `XLEN` per Requirements 12.5
    - Implement `getWalletProfile(address)` / `saveWalletProfile(profile)` using `HSET`/`HGETALL` on `wallet:{address}` with no TTL per Requirements 13.1
    - Implement `hasAlertBeenSent(type, marketId, walletAddress)` / `recordSentAlert(...)` using `SETEX alert:{type}:{marketId}:{walletAddress}` per Requirements 9.4
    - Implement `hasClusterAlertBeenSent(marketId, side)` / `recordClusterAlert(...)` using `SETEX cluster:{marketId}:{side}` per Requirements 9.6
    - Implement `getWalletFunder(address)` / `cacheWalletFunder(address, funder)` using `HGET`/`HSET wallet:{address} funder` per Requirements 7.1, 7.2
    - Fall back to in-memory dedup map when Redis is unavailable per Requirements 16.4
    - _Requirements: 9.3, 9.4, 12.1, 12.2, 12.3, 12.5, 13.1, 13.2_

  - [x] 5.2 Write unit tests for RedisCache
    - Test wallet profile save/retrieve round-trip
    - Test alert dedup: false before record, true after, false after TTL expiry
    - Test stream push and read round-trip
    - Test XACK removes message from pending
    - Test in-memory fallback when Redis unavailable
    - _Requirements: 9.4, 12.3, 13.2_

  - [x] 5.3 Write property test for alert deduplication
    - **Property 14: Alert Deduplication via Redis TTL** — `hasAlertBeenSent` returns true for same key within TTL, false after expiry
    - **Validates: Requirements 9.3, 9.4**

- [x] 6. TimescaleDB
  - [x] 6.1 Implement `src/db/TimeSeriesDB.ts` using `pg`
    - Implement `connect()` initializing pg connection pool
    - Implement `initSchema()` — create `price_history` and `cluster_trades` hypertables, indexes, and `market_volatility_1h` continuous aggregate if not exists per Requirements 17.7 and design Model 11
    - Call `initSchema()` on `connect()` so schema is always up-to-date on startup
    - Implement `appendPricePoint(marketId, price, timestamp)` — async INSERT into `price_history` per Requirements 8.1
    - Implement `getPriceHistory(marketId, since)` — SELECT from `price_history` ordered by time ASC per Requirements 8.6
    - Implement `getMarketVolatility(marketId, windowMinutes)` — query `market_volatility_1h` continuous aggregate, return `MarketVolatility` with `sampleCount` per Requirements 8.2
    - Implement `recordClusterTrade(trade)` — INSERT into `cluster_trades` per Requirements 6.1
    - Implement `getClusterWallets(marketId, side, since)` — SELECT DISTINCT wallet_address per Requirements 6.2
    - Implement `getClusterTotalSize(marketId, side, since)` — SELECT SUM(size_usd) per design Function 9
    - Return null/empty gracefully on DB unavailability per Requirements 16.2
    - _Requirements: 6.1, 6.2, 8.1, 8.2, 8.6, 8.7, 17.7_

  - [x] 6.2 Write unit tests for TimeSeriesDB
    - Test `appendPricePoint` and `getPriceHistory` round-trip within time window
    - Test `getMarketVolatility` returns correct mean/stddev
    - Test `getClusterWallets` returns distinct wallets only
    - Test graceful null return when DB unavailable
    - _Requirements: 8.2, 8.6, 13.3_

  - [x] 6.3 Write property test for price history window
    - **Property 10: Monotonic Timestamp Ordering** — all prices returned by `getPriceHistory` are within the requested time range
    - **Validates: Requirements 8.1, 8.6**

- [x] 7. Checkpoint — core infrastructure
  - Ensure all tests pass, ask the user if questions arise.


- [x] 8. WebSocket Manager
  - [x] 8.1 Implement `src/websocket/WebSocketManager.ts` using `ws`
    - Implement `connect()` — establish WebSocket to `POLYMARKET_WS_URL`, register `message`, `error`, `close` listeners per Requirements 1.1, 1.2
    - Implement `disconnect()` — graceful close, clear reconnect timers
    - Implement `onTrade(callback)`, `onError(callback)`, `onReconnect(callback)` event registration
    - Implement `isConnected()` checking `ws.readyState === WebSocket.OPEN`
    - On `close` or `error`: trigger reconnection using `exponentialBackoff` (1s→2s→4s→8s→16s→32s→60s max) per Requirements 1.5
    - Apply 30-second connection timeout per attempt per Requirements 1.6
    - Parse incoming messages into `RawTrade` objects; validate fields per Requirements 15.1
    - Log warning and skip on malformed messages per Requirements 15.2
    - Handle `SIGINT` to call `disconnect()` per Requirements 1.7
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 15.1, 15.2_

  - [x] 8.2 Write unit tests for WebSocketManager
    - Test connection establishment and event listener registration
    - Test reconnection triggered on close/error
    - Test exponential backoff delay sequence
    - Test 30-second timeout per attempt
    - Test malformed message is skipped without crash
    - _Requirements: 1.5, 1.6, 15.2_

  - [x] 8.3 Write property test for WebSocket reconnection
    - **Property 3: WebSocket Reconnection Guarantee** — for any sequence of disconnection events, reconnection is always attempted with correct backoff delays
    - **Validates: Requirements 1.5, 1.6**

- [x] 9. Trade Filter
  - [x] 9.1 Implement `src/filters/TradeFilter.ts`
    - Implement `filter(trade: RawTrade): FilteredTrade | null`
    - Return `FilteredTrade` iff `trade.size_usd >= minTradeSizeUSDC` per Requirements 2.1
    - Return null if below threshold per Requirements 2.2
    - Normalize all field names to camelCase in returned `FilteredTrade` per Requirements 2.3
    - Do NOT mutate the input `RawTrade` per Requirements 2.4
    - Set `walletAddress` to taker for buys, maker for sells
    - Implement `setMinimumSize(sizeUSDC)` and `getMinimumSize()` per design Component 2
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 9.2 Write unit tests for TradeFilter
    - Test exactly at threshold (pass), just below (null), just above (pass)
    - Test camelCase normalization of output fields
    - Test input object is not mutated
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 9.3 Write property test for trade filtering
    - **Property 1: Trade Filtering Consistency** — `filter(trade, threshold)` returns non-null iff `trade.size_usd >= threshold`
    - **Validates: Requirements 2.1, 2.2**

  - [x] 9.4 Write property test for filtering monotonicity
    - For any array of trades and two thresholds `t1 <= t2`, trades passing `t2` is a subset of trades passing `t1`
    - **Validates: Requirements 2.1, 2.2**


- [x] 10. Blockchain Analyzer
  - [x] 10.1 Implement `src/blockchain/BlockchainAnalyzer.ts`
    - Implement `analyzeWalletProfile(address, redisCache)` — cache-first: return immediately on Redis hit per Requirements 5.1
    - On cache miss: call `alchemy_getAssetTransfers` with `fromBlock: "0x0"`, `toAddress: address`, `maxCount: 1`, `order: "asc"` per Requirements 5.2
    - Persist fetched profile to Redis before returning per Requirements 5.3
    - Fall back to Moralis `/{address}/verbose` endpoint if Alchemy fails per Requirements 5.4
    - If both fail: assume wallet is 1 year old and continue without throwing per Requirements 5.5
    - Implement `getWalletFunder(address)` — extract `from` of first inbound tx; cache in `HSET wallet:{address} funder` per Requirements 7.1, 7.2
    - Implement `analyzeClusterFunding(wallets)` — for each wallet check Redis funder cache, then Alchemy; build `funders` and `sharedFunders` maps; detect common non-exchange funders per Requirements 7.3, 7.4
    - Skip individual wallet on Alchemy failure (non-blocking) per Requirements 7.5
    - Return `FundingAnalysis` with `hasCommonNonExchangeFunder: false` if all lookups fail per Requirements 7.6
    - Validate all addresses with `isValidEthAddress` before API calls per Requirements 19.3
    - Implement rate limiting: max 5 Alchemy requests/second per Requirements 20.3
    - Use HTTPS for all external API calls per Requirements 19.5
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 19.3, 20.3_

  - [x] 10.2 Write unit tests for BlockchainAnalyzer
    - Mock Alchemy API responses; test cache-first: no API call when Redis has profile
    - Test Moralis fallback when Alchemy fails
    - Test 1-year-old assumption when both APIs fail
    - Test `analyzeClusterFunding` correctly identifies shared funders
    - Test known exchange wallets are NOT flagged as common funders
    - Test partial failure: one wallet lookup fails, others succeed
    - Test Redis caching of funder addresses prevents duplicate Alchemy calls
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 7.3, 7.4, 7.5_

  - [x] 10.3 Write property test for wallet profile caching
    - **Property 6: Wallet Profile Caching Correctness** — `analyzeWalletProfile` makes at most one Alchemy call per address; all subsequent calls return cached value
    - **Validates: Requirements 5.1, 5.3, 13.2**

  - [x] 10.4 Write property test for funding analysis non-blocking
    - **Property 18: Funding Analysis Non-Blocking** — for any set of wallets with partial lookup failures, `analyzeClusterFunding` always returns a complete `FundingAnalysis` without throwing
    - **Validates: Requirements 7.5, 7.6, 7.7**

- [x] 11. Anomaly Detector
  - [x] 11.1 Implement `detectRapidOddsShift` in `src/detectors/AnomalyDetector.ts`
    - Return null if `priceHistory` is empty per Requirements 3.6
    - Use Z-score when `volatility.sampleCount >= ZSCORE_MIN_SAMPLES` and `stddevPriceChange > 0` per Requirements 3.1
    - Fall back to static `RAPID_ODDS_SHIFT_PERCENT` threshold when insufficient samples per Requirements 3.2
    - Set severity HIGH if Z-score > 2× threshold or static change > 25%; MEDIUM otherwise per Requirements 3.3, 3.4
    - Set `confidence = Math.min(zScore / (ZSCORE_THRESHOLD * 2), 1.0)` for Z-score path per Requirements 3.5
    - Do NOT mutate input parameters per Requirements 3.7
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 11.2 Implement `detectWhaleActivity` in `src/detectors/AnomalyDetector.ts`
    - Return null if `orderBookLiquidity` is zero or unavailable per Requirements 4.3
    - Use Z-score against trade size distribution when baseline available per Requirements 4.1
    - Fall back to static liquidity percentage threshold per Requirements 4.2
    - Set severity HIGH if Z-score > 2× threshold or liquidity > 50%; MEDIUM if > 20%; LOW otherwise per Requirements 4.4, 4.5
    - Set `confidence = Math.min(zScore / (ZSCORE_THRESHOLD * 2), 1.0)` per Requirements 4.6
    - Do NOT mutate input parameters per Requirements 4.7
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 11.3 Implement `detectInsiderTrading` in `src/detectors/AnomalyDetector.ts`
    - Check Redis cache for `WalletProfile` before any Alchemy call per Requirements 5.1
    - Flag if all three conditions met: `ageHours < INSIDER_WALLET_AGE_HOURS`, `sizeUSDC >= INSIDER_MIN_TRADE_SIZE`, `marketCategory` in `NICHE_MARKET_CATEGORIES` per Requirements 5.6
    - Calculate confidence: `ageScore * 0.4 + sizeScore * 0.3 + activityScore * 0.3` per Requirements 5.7
    - Set severity HIGH if confidence > 0.8, MEDIUM if > 0.5, LOW otherwise per Requirements 5.8
    - Do NOT mutate input parameters per Requirements 5.9
    - _Requirements: 5.1, 5.6, 5.7, 5.8, 5.9_

  - [x] 11.4 Implement `analyze(trade)` orchestrator in `src/detectors/AnomalyDetector.ts`
    - Fetch `MarketVolatility` from `TimeSeriesDB.getMarketVolatility()` before detection per design Component 3
    - Fetch `PriceHistory` from `TimeSeriesDB.getPriceHistory()` for rapid odds shift
    - Call all three detection methods and collect non-null results
    - Validate `anomaly.confidence` is in [0, 1] per Requirements 15.3
    - Validate `anomaly.type` and `anomaly.severity` per Requirements 15.4, 15.5
    - Continue with static thresholds if TimescaleDB unavailable per Requirements 16.2
    - _Requirements: 3.1, 4.1, 5.6, 8.3, 8.4, 15.3, 15.4, 15.5, 16.1, 16.2_

  - [x] 11.5 Write unit tests for AnomalyDetector
    - Test rapid odds shift: Z-score path, static fallback, empty history returns null
    - Test whale detection: Z-score path, static fallback, zero liquidity returns null
    - Test insider detection: all three conditions required, confidence formula
    - Test severity assignments for each detection type
    - Test confidence always in [0, 1]
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 5.6, 15.3_

  - [x] 11.6 Write property test for confidence score bounds
    - **Property 7: Confidence Score Bounds** — for any anomaly produced, `0 <= anomaly.confidence <= 1`
    - **Validates: Requirements 15.3**

  - [x] 11.7 Write property test for Z-score detection threshold
    - **Property 15: Z-Score Baseline Accuracy** — anomalies triggered at exactly `ZSCORE_THRESHOLD` sigma, not below
    - **Property 16: Z-Score Static Fallback** — when `sampleCount < ZSCORE_MIN_SAMPLES`, only static thresholds used
    - **Validates: Requirements 3.1, 3.2, 4.1, 4.2, 8.3, 8.4**

  - [x] 11.8 Write property test for anomaly detection completeness
    - **Property 2: Anomaly Detection Completeness** — for any trade with known anomalous characteristics, all applicable anomaly types are returned
    - **Validates: Requirements 3.1, 4.1, 5.6**


- [x] 12. Cluster Detector
  - [x] 12.1 Implement `src/detectors/ClusterDetector.ts`
    - Implement `recordTrade(trade)` — call `TimeSeriesDB.recordClusterTrade()` for every filtered trade per Requirements 6.1
    - Implement `detectCluster(trade)` — after recording, query `TimeSeriesDB.getClusterWallets()` for distinct wallets within `CLUSTER_WINDOW_MINUTES` per Requirements 6.2
    - Return null if distinct wallet count < `CLUSTER_MIN_WALLETS` per Requirements 6.3
    - Call `BlockchainAnalyzer.analyzeClusterFunding(wallets)` when threshold met per Requirements 6.4
    - Set severity CRITICAL and attach `fundingAnalysis` when `hasCommonNonExchangeFunder === true` per Requirements 6.5
    - Set severity HIGH if wallet count >= 5, MEDIUM if >= 3 when no common funder per Requirements 6.6
    - Deduplicate via `RedisCache.hasClusterAlertBeenSent()` per Requirements 6.7
    - Ensure `ClusterAnomaly.wallets` contains only distinct addresses per Requirements 6.8
    - Do NOT mutate input `FilteredTrade` per Requirements 6.9
    - Degrade to HIGH severity (non-blocking) if funding analysis fails per design Error Scenario 11
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

  - [x] 12.2 Write unit tests for ClusterDetector
    - Test no cluster when wallet count < clusterMinWallets
    - Test cluster returned when count >= clusterMinWallets
    - Test same wallet trading multiple times counts as 1 distinct wallet
    - Test trades outside time window excluded
    - Test CRITICAL severity when common non-exchange funder found
    - Test HIGH for >= 5 wallets, MEDIUM for 3-4 wallets
    - Test funding analysis failure degrades to HIGH (non-blocking)
    - _Requirements: 6.3, 6.5, 6.6, 6.8_

  - [x] 12.3 Write property test for cluster wallet distinctness
    - **Property 13: Cluster Wallet Distinctness** — all wallet addresses in `ClusterAnomaly.wallets` are distinct
    - **Validates: Requirements 6.8**

  - [x] 12.4 Write property test for cluster threshold monotonicity
    - **Property 12: Cluster Detection Threshold Monotonicity** — clusters detected with threshold `t2 >= t1` is always <= clusters with `t1`
    - **Validates: Requirements 6.3, 6.4**

  - [x] 12.5 Write property test for CRITICAL severity upgrade
    - **Property 17: CRITICAL Severity Upgrade Conditions** — `severity === 'CRITICAL'` iff `fundingAnalysis.hasCommonNonExchangeFunder === true`
    - **Validates: Requirements 6.5, 6.6**

- [x] 13. Checkpoint — detection pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Alert Formatter
  - [x] 14.1 Implement `src/alerts/AlertFormatter.ts`
    - Implement `format(anomaly, trade)` dispatcher routing to type-specific formatters
    - Implement `formatRapidOddsShift(anomaly, trade)` — include market name, side, size with thousand separators, Z-score or static threshold info per Requirements 10.2
    - Implement `formatWhaleAlert(anomaly, trade)` — include liquidity consumed percentage and Z-score metrics
    - Implement `formatInsiderAlert(anomaly, trade)` — include wallet age, tx count, risk score
    - Implement `formatClusterAlert(anomaly: ClusterAnomaly)` — for CRITICAL: include common funder address, PolygonScan funder link, list of funded wallets with links per Requirements 10.5
    - Apply severity emoji: 🚨 for HIGH/CRITICAL, ⚠️ for MEDIUM, ℹ️ for LOW per Requirements 10.1
    - Include PolygonScan wallet link and Polymarket market URL per Requirements 10.3, 10.4
    - Escape all user-controlled fields with `escapeMarkdown()` per Requirements 10.6, 19.2
    - Truncate message to 4096 chars per Requirements 10.7
    - Set `parse_mode: 'Markdown'` and `disable_web_page_preview: false` per Requirements 10.8
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [x] 14.2 Write unit tests for AlertFormatter
    - Test emoji selection for each severity level
    - Test PolygonScan and Polymarket URL generation
    - Test CRITICAL cluster alert includes funder address and funded wallet links
    - Test message length <= 4096 chars for all anomaly types
    - Test markdown escaping of special characters in market names
    - _Requirements: 10.1, 10.5, 10.6, 10.7_

  - [x] 14.3 Write property test for Telegram message length
    - **Property 8: Telegram Message Length Compliance** — for any anomaly and trade combination, formatted message length is <= 4096 characters
    - **Validates: Requirements 10.7**

- [x] 15. Telegram Notifier
  - [x] 15.1 Implement `src/notifications/TelegramNotifier.ts`
    - Implement `sendAlert(message)` — POST to `https://api.telegram.org/bot{token}/sendMessage` per Requirements 11.1
    - Retry with exponential backoff on failure, max 3 attempts per Requirements 11.2
    - Respect 30 msg/sec rate limit per Requirements 11.3
    - Implement `testConnection()` — call `getMe` endpoint; return false on failure per Requirements 11.4
    - On all retries exhausted: log alert details to file system, do NOT crash per Requirements 11.5
    - Use HTTPS for all Telegram API calls per Requirements 19.5
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 15.2 Write unit tests for TelegramNotifier
    - Mock Telegram API; test successful send
    - Test retry logic: 3 attempts with backoff on failure
    - Test file-system fallback when all retries fail
    - Test `testConnection()` returns false on API error
    - _Requirements: 11.2, 11.4, 11.5_


- [x] 16. Ingestor Service
  - [x] 16.1 Implement `src/ingestor/index.ts`
    - Instantiate `ConfigManager`, `Logger`, `RedisCache`, `WebSocketManager`
    - Connect Redis and create consumer group `analyzers` on `trades:stream` (idempotent)
    - Register `wsManager.onTrade()` callback: normalize `RawTrade` → `NormalizedTrade` (snake_case), push to stream via `XADD MAXLEN ~ 100000` — fire-and-forget, never await downstream per Requirements 1.4
    - Validate raw trade fields before normalizing; log warning and skip on failure per Requirements 15.1, 15.2
    - Register `SIGINT` handler: disconnect WebSocket and Redis, then `process.exit(0)` per Requirements 1.7
    - Implement `getStreamDepth()` proxy to `RedisCache.getStreamDepth()` per Requirements 12.5
    - On Redis unavailability: retry with exponential backoff, do NOT silently drop frames per Requirements 16.3
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 12.1, 15.1, 15.2, 16.3_

- [x] 17. Analyzer Service
  - [x] 17.1 Implement `src/analyzer/index.ts`
    - Instantiate all components: `ConfigManager`, `Logger`, `RedisCache`, `TimeSeriesDB`, `TradeFilter`, `BlockchainAnalyzer`, `AnomalyDetector`, `ClusterDetector`, `AlertFormatter`, `TelegramNotifier`
    - Connect Redis and TimescaleDB; call `telegramNotifier.testConnection()` — exit with code 1 on failure per Requirements 11.4
    - Implement consumer loop: `XREADGROUP COUNT 10 BLOCK 100` per Requirements 12.2
    - For each message: deserialize stream fields → `RawTrade`, apply `TradeFilter`
    - If filtered out: `XACK` and continue per Requirements 2.2, 12.3
    - Run `ClusterDetector.detectCluster()` and `AnomalyDetector.analyze()` in parallel
    - For each anomaly: check `hasAlertBeenSent`, format, send via Telegram, `recordSentAlert` per Requirements 9.1, 9.2, 9.3
    - Append price point to TimescaleDB after processing per Requirements 8.1
    - `XACK` every message — even on processing error — to prevent infinite redelivery per Requirements 12.4
    - Monitor stream depth every 30 seconds; log warning at > 10,000; send Telegram alert at > 50,000 per Requirements 12.6, 12.7
    - Log warning when Alchemy fails > 10 consecutive times per Requirements 16.6
    - Log warning when TimescaleDB unavailable > 5 minutes per Requirements 16.7
    - Log warning when malformed trade error rate > 10% per Requirements 16.5
    - _Requirements: 8.1, 9.1, 9.2, 9.3, 11.4, 12.2, 12.3, 12.4, 12.6, 12.7, 16.5, 16.6, 16.7_

  - [x] 17.2 Write property test for stream delivery guarantee
    - **Property 5: Stream Delivery Guarantee** — every trade pushed to `trades:stream` is eventually read and acknowledged by the Analyzer
    - **Validates: Requirements 12.2, 12.3**

  - [x] 17.3 Write property test for alert delivery idempotency
    - **Property 4: Alert Delivery Idempotency** — exactly one Telegram alert is sent per anomaly within the deduplication TTL window
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 18. Deployment configuration
  - [x] 18.1 Create `ecosystem.config.js`
    - Define `polymarket-ingestor` process: `script: './dist/ingestor/index.js'`, `autorestart: true`, `max_memory_restart: '256M'`, `restart_delay: 5000`, separate error/out log files per Requirements 17.1, 17.4
    - Define `polymarket-analyzer` process: `script: './dist/analyzer/index.js'`, `autorestart: true`, `max_memory_restart: '500M'`, `restart_delay: 5000`, separate error/out log files per Requirements 17.2, 17.4
    - _Requirements: 17.1, 17.2, 17.4_

  - [x] 18.2 Create `docker-compose.yml`
    - Define `redis` service: `redis:7-alpine`, port 6379, `appendonly yes`, persistent volume per Requirements 17.3
    - Define `timescaledb` service: `timescale/timescaledb:latest-pg15`, port 5432, env vars for user/password/db, persistent volume per Requirements 17.3
    - _Requirements: 17.3_

- [x] 19. Checkpoint — services and deployment
  - Ensure all tests pass, ask the user if questions arise.


- [x] 20. Integration tests
  - [x] 20.1 Write integration test for end-to-end trade processing
    - Mock Polymarket WebSocket server emitting sample trades
    - Mock Alchemy API with wallet data
    - Mock Telegram API
    - Verify complete flow: trade received → filtered → analyzed → alert sent
    - Verify correct anomaly detection for known anomalous scenarios (rapid shift, whale, insider)
    - _Requirements: 1.3, 1.4, 2.1, 3.1, 4.1, 5.6_

  - [x] 20.2 Write integration test for WebSocket reconnection lifecycle
    - Test connection establishment to mock WebSocket server
    - Test automatic reconnection on disconnect with correct backoff timing
    - Test graceful shutdown on SIGINT
    - _Requirements: 1.5, 1.6, 1.7_

  - [x] 20.3 Write integration test for Redis Stream round-trip
    - Test Ingestor pushes to stream and Analyzer reads and acknowledges
    - Test consumer group semantics: message not redelivered after XACK
    - Test stream depth monitoring and warning thresholds
    - _Requirements: 12.1, 12.2, 12.3, 12.5, 12.6_

  - [x] 20.4 Write integration test for graceful degradation
    - Test Analyzer continues with static thresholds when TimescaleDB unavailable
    - Test Analyzer continues when Alchemy unavailable (no crash)
    - Test in-memory dedup fallback when Redis unavailable for alert dedup
    - _Requirements: 16.1, 16.2, 16.4_

  - [x] 20.5 Write property test for Redis persistence across restarts
    - **Property 11: Redis Persistence Across Restarts** — wallet profile saved before termination is returned after client reconnection without any Alchemy API call
    - **Validates: Requirements 13.1, 13.2**

  - [x] 20.6 Write property test for graceful degradation on RPC failure
    - **Property 9: Graceful Degradation on RPC Failure** — for any Alchemy API failure, Analyzer continues detecting rapid odds shifts and whale activity without crashing
    - **Validates: Requirements 16.1**

- [ ] 21. Documentation
  - [x] 21.1 Create `README.md`
    - Prerequisites section: Node.js 20.x, Docker, PM2, Ubuntu VPS specs
    - Setup section: clone, `npm install`, `npm run build`, copy `.env.example` to `.env`
    - Infrastructure section: `docker compose up -d` to start Redis and TimescaleDB
    - PM2 deployment section: `pm2 start ecosystem.config.js`, `pm2 save`, `pm2 startup`
    - Configuration reference: all env vars with types, defaults, and descriptions
    - Monitoring section: `pm2 monit`, `pm2 logs`, Redis stream depth check commands
    - _Requirements: 17.7_

- [x] 22. Final checkpoint — all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` and validate universal correctness properties from the design document
- Unit tests use `jest` with `ts-jest`
- Integration tests use Jest with mocked external services (no live API calls required)
- Checkpoints at tasks 7, 13, 19, and 22 ensure incremental validation
- The design document's 18 correctness properties are each covered by at least one property-based test sub-task
