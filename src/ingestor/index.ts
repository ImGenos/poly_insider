import * as dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../config/ConfigManager';
import { Logger } from '../utils/Logger';
import { RedisCache } from '../cache/RedisCache';
import { WebSocketManager } from '../websocket/WebSocketManager';
import { DataAPIPoller } from './DataAPIPoller';
import { TradeEnricher } from './TradeEnricher';
import { RawTrade, NormalizedTrade } from '../types/index';
import { isValidEthAddress, exponentialBackoff } from '../utils/helpers';

const STREAM_KEY = 'trades:stream';
const CONSUMER_GROUP = 'analyzers';
const MAX_BACKOFF_MS = 60_000;

// ─── Validation ───────────────────────────────────────────────────────────────

function validateRawTrade(t: RawTrade): boolean {
  if (!t.market_id || typeof t.market_id !== 'string' || t.market_id.trim() === '') return false;
  if (t.side !== 'YES' && t.side !== 'NO') return false;
  if (typeof t.price !== 'number' || t.price < 0 || t.price > 1) return false;
  if (typeof t.size_usd !== 'number' || t.size_usd <= 0) return false;
  if (typeof t.timestamp !== 'number' || !isFinite(t.timestamp) || t.timestamp <= 0) return false;
  // Addresses are optional (not exposed by the Polymarket CLOB WS market channel).
  // When present, they must be valid Ethereum addresses. Zero-address placeholders
  // from upstream sources are accepted here; downstream consumers can filter them.
  if (t.maker_address !== undefined && !isValidEthAddress(t.maker_address)) return false;
  if (t.taker_address !== undefined && !isValidEthAddress(t.taker_address)) return false;
  return true;
}

function normalize(trade: RawTrade): NormalizedTrade {
  return {
    market_id: trade.market_id,
    market_name: trade.market_name,
    outcome: trade.outcome,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    size_usd: trade.size_usd,
    timestamp: trade.timestamp,
    maker_address: trade.maker_address,
    taker_address: trade.taker_address,
    bid_liquidity: trade.order_book_depth?.bid_liquidity ?? 0,
    ask_liquidity: trade.order_book_depth?.ask_liquidity ?? 0,
    market_category: trade.market_category,
  };
}

function toStreamFields(trade: NormalizedTrade): Record<string, string> {
  const fields: Record<string, string> = {
    market_id: trade.market_id,
    market_name: trade.market_name,
    side: trade.side,
    price: String(trade.price),
    size: String(trade.size),
    size_usd: String(trade.size_usd),
    timestamp: String(trade.timestamp),
    bid_liquidity: String(trade.bid_liquidity),
    ask_liquidity: String(trade.ask_liquidity),
    market_category: trade.market_category ?? '',
  };
  // Only include optional fields when they are present
  if (trade.outcome !== undefined) fields['outcome'] = trade.outcome;
  if (trade.maker_address !== undefined) fields['maker_address'] = trade.maker_address;
  if (trade.taker_address !== undefined) fields['taker_address'] = trade.taker_address;
  return fields;
}

// ─── Fire-and-forget push with exponential backoff on Redis unavailability ────

async function pushWithRetry(
  redisCache: RedisCache,
  fields: Record<string, string>,
  logger: Logger,
  maxAttempts = 10,
): Promise<boolean> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      await redisCache.pushToStream(STREAM_KEY, fields);
      return true;
    } catch (err) {
      logger.error('Failed to push trade to Redis stream, retrying with backoff', err, { attempt });
      await exponentialBackoff(attempt, MAX_BACKOFF_MS);
      attempt++;
    }
  }
  logger.warn('pushWithRetry: max attempts reached, dropping trade', {
    maxAttempts,
    market_id: fields['market_id'],
    side: fields['side'],
  });
  return false;
}

// ─── IngestorService ──────────────────────────────────────────────────────────

export class IngestorService {
  private config: ConfigManager | null;
  private logger: Logger;
  private redisCache: RedisCache | null = null;
  private wsManager: WebSocketManager | null = null;
  private dataAPIPoller: DataAPIPoller | null = null;
  private tradeEnricher: TradeEnricher | null = null;

  private droppedTrades = 0;
  private droppedLogTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param config Pre-constructed ConfigManager. When omitted, a new one is
   *   created inside start() so that env vars are only required at runtime,
   *   not at construction time — making the service unit-testable without a
   *   full environment.
   */
  constructor(config?: ConfigManager) {
    this.config = config ?? null;
    // Use a temporary info-level logger until config is available in start()
    this.logger = new Logger('info', undefined);
  }

  async start(): Promise<void> {
    // Build config (and dependent services) here if not injected
    if (!this.config) {
      this.config = new ConfigManager();
    }
    const config = this.config;

    this.logger = new Logger(config.getLogLevel(), config.getLogFilePath());
    this.redisCache = new RedisCache(config.getRedisUrl(), this.logger);
    this.wsManager = new WebSocketManager(config.getPolymarketWsUrl(), this.logger);
    this.dataAPIPoller = new DataAPIPoller(this.logger, 10000); // Poll every 10 seconds
    this.tradeEnricher = new TradeEnricher(this.logger);

    this.logger.info('IngestorService starting');

    // Connect Redis and create consumer group (idempotent)
    await this.redisCache.connect();
    await this.redisCache.createConsumerGroup(STREAM_KEY, CONSUMER_GROUP);

    // Periodically log the dropped-trade counter so operators can see the drop rate
    this.droppedLogTimer = setInterval(() => {
      if (this.droppedTrades > 0) {
        this.logger.warn('IngestorService: trades dropped due to Redis unavailability', {
          droppedSinceLastLog: this.droppedTrades,
        });
        this.droppedTrades = 0;
      }
    }, 60_000);

    // Register trade callback for WebSocket
    this.wsManager.onTrade((rawTrade: RawTrade) => {
      this._handleTrade(rawTrade, 'WebSocket');
    });

    // Register trade callback for Data API Poller
    this.dataAPIPoller.onTrade((rawTrade: RawTrade) => {
      this._handleTrade(rawTrade, 'DataAPI');
    });

    this.wsManager.onError((err: Error) => {
      this.logger.error('WebSocket error', err);
    });

    this.wsManager.onReconnect(() => {
      this.logger.info('WebSocket reconnecting...');
    });

    // SIGINT handler per Requirements 1.7
    process.on('SIGINT', () => {
      this.stop().then(() => process.exit(0));
    });

    // Connect WebSocket per Requirements 1.1
    await this.wsManager.connect();

    // Start Data API Poller
    this.dataAPIPoller.start();

    this.logger.info('IngestorService started');
  }

  private _handleTrade(rawTrade: RawTrade, source: string): void {
    // Validate per Requirements 15.1, 15.2
    if (!validateRawTrade(rawTrade)) {
      this.logger.warn(`Ingestor: invalid raw trade from ${source}, skipping`, {
        market_id: rawTrade?.market_id,
        side: rawTrade?.side,
        price: rawTrade?.price,
        size_usd: rawTrade?.size_usd,
        timestamp: rawTrade?.timestamp,
        maker_address: rawTrade?.maker_address,
        taker_address: rawTrade?.taker_address,
      });
      return;
    }

    // Enrich trades based on source
    let enrichedTrade = rawTrade;
    if (source === 'DataAPI') {
      // Cache Data API trades for enrichment
      this.tradeEnricher!.addDataAPITrade(rawTrade);
      enrichedTrade = rawTrade;
    } else if (source === 'WebSocket') {
      // Enrich WebSocket trades with cached wallet addresses
      enrichedTrade = this.tradeEnricher!.enrichWebSocketTrade(rawTrade);
    }

    const normalized = normalize(enrichedTrade);
    const fields = toStreamFields(normalized);

    // Fire-and-forget: never await downstream per Requirements 1.4
    // Retry with exponential backoff on Redis unavailability per Requirements 16.3
    pushWithRetry(this.redisCache!, fields, this.logger).then((pushed) => {
      if (!pushed) this.droppedTrades++;
    }).catch((err) => {
      this.logger.error('Unexpected error in pushWithRetry', err);
    });
  }

  async stop(): Promise<void> {
    this.logger.info('IngestorService stopping');
    if (this.droppedLogTimer !== null) {
      clearInterval(this.droppedLogTimer);
      this.droppedLogTimer = null;
    }
    this.tradeEnricher?.stop();
    this.dataAPIPoller?.stop();
    this.wsManager?.disconnect();
    await this.redisCache?.disconnect();
    this.logger.info('IngestorService stopped');
  }

  async getStreamDepth(): Promise<number> {
    return this.redisCache?.getStreamDepth(STREAM_KEY) ?? 0;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default async function main(): Promise<void> {
  const service = new IngestorService();
  await service.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in ingestor:', err);
    process.exit(1);
  });
}
