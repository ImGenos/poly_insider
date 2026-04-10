import * as dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../config/ConfigManager';
import { Logger } from '../utils/Logger';
import { RedisCache } from '../cache/RedisCache';
import { WebSocketManager } from '../websocket/WebSocketManager';
import { RawTrade, NormalizedTrade } from '../types/index';
import { isValidEthAddress, exponentialBackoff } from '../utils/helpers';

const STREAM_KEY = 'trades:stream';
const CONSUMER_GROUP = 'analyzers';
const MAX_BACKOFF_MS = 60_000;

// ─── Validation ───────────────────────────────────────────────────────────────

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

function validateRawTrade(t: RawTrade): boolean {
  if (!t.market_id || typeof t.market_id !== 'string' || t.market_id.trim() === '') return false;
  if (t.side !== 'YES' && t.side !== 'NO') return false;
  if (typeof t.price !== 'number' || t.price < 0 || t.price > 1) return false;
  if (typeof t.size_usd !== 'number' || t.size_usd <= 0) return false;
  if (typeof t.timestamp !== 'number' || !isFinite(t.timestamp) || t.timestamp <= 0) return false;
  // Addresses are optional (not exposed by the Polymarket CLOB WS market channel).
  // When present, they must be valid non-zero Ethereum addresses.
  if (t.maker_address !== undefined && (!isValidEthAddress(t.maker_address) || isZeroAddress(t.maker_address))) return false;
  if (t.taker_address !== undefined && (!isValidEthAddress(t.taker_address) || isZeroAddress(t.taker_address))) return false;
  return true;
}

function normalize(trade: RawTrade): NormalizedTrade {
  return {
    market_id: trade.market_id,
    market_name: trade.market_name,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    size_usd: trade.size_usd,
    timestamp: trade.timestamp,
    maker_address: trade.maker_address,
    taker_address: trade.taker_address,
    bid_liquidity: trade.order_book_depth?.bid_liquidity ?? 0,
    ask_liquidity: trade.order_book_depth?.ask_liquidity ?? 0,
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
  };
  // Only include addresses when they are known
  if (trade.maker_address !== undefined) fields['maker_address'] = trade.maker_address;
  if (trade.taker_address !== undefined) fields['taker_address'] = trade.taker_address;
  return fields;
}

// ─── Fire-and-forget push with exponential backoff on Redis unavailability ────

async function pushWithRetry(
  redisCache: RedisCache,
  fields: Record<string, string>,
  logger: Logger,
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await redisCache.pushToStream(STREAM_KEY, fields);
      return;
    } catch (err) {
      logger.error('Failed to push trade to Redis stream, retrying with backoff', err, { attempt });
      await exponentialBackoff(attempt, MAX_BACKOFF_MS);
      attempt++;
    }
  }
}

// ─── IngestorService ──────────────────────────────────────────────────────────

export class IngestorService {
  private readonly config: ConfigManager;
  private readonly logger: Logger;
  private readonly redisCache: RedisCache;
  private readonly wsManager: WebSocketManager;

  constructor() {
    this.config = new ConfigManager();
    this.logger = new Logger(this.config.getLogLevel(), this.config.getLogFilePath());
    this.redisCache = new RedisCache(this.config.getRedisUrl(), this.logger);
    this.wsManager = new WebSocketManager(this.config.getPolymarketWsUrl(), this.logger);
  }

  async start(): Promise<void> {
    this.logger.info('IngestorService starting');

    // Connect Redis and create consumer group (idempotent)
    await this.redisCache.connect();
    await this.redisCache.createConsumerGroup(STREAM_KEY, CONSUMER_GROUP);

    // Register trade callback
    this.wsManager.onTrade((rawTrade: RawTrade) => {
      // Validate per Requirements 15.1, 15.2
      if (!validateRawTrade(rawTrade)) {
        this.logger.warn('Ingestor: invalid raw trade, skipping', {
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

      const normalized = normalize(rawTrade);
      const fields = toStreamFields(normalized);

      // Fire-and-forget: never await downstream per Requirements 1.4
      // Retry with exponential backoff on Redis unavailability per Requirements 16.3
      pushWithRetry(this.redisCache, fields, this.logger).catch((err) => {
        this.logger.error('Unexpected error in pushWithRetry', err);
      });
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

    this.logger.info('IngestorService started');
  }

  async stop(): Promise<void> {
    this.logger.info('IngestorService stopping');
    this.wsManager.disconnect();
    await this.redisCache.disconnect();
    this.logger.info('IngestorService stopped');
  }

  async getStreamDepth(): Promise<number> {
    return this.redisCache.getStreamDepth(STREAM_KEY);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default async function main(): Promise<void> {
  const service = new IngestorService();
  await service.start();
}

main().catch((err) => {
  console.error('Fatal error in ingestor:', err);
  process.exit(1);
});
