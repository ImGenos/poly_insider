import Redis from 'ioredis';
import { WalletProfile, StreamMessage } from '../types/index';
import { Logger } from '../utils/Logger';

export class RedisCache {
  private client: Redis | null = null;
  private readonly url: string;
  private readonly logger: Logger;
  isConnected = false;

  // In-memory fallback for alert dedup when Redis is unavailable.
  // Stores expiry timestamps (ms). Capped at DEDUP_MAP_MAX_SIZE entries.
  private readonly dedupMap = new Map<string, number>();
  private static readonly DEDUP_MAP_MAX_SIZE = 10_000;

  constructor(url: string, logger: Logger) {
    this.url = url;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    this.client = new Redis(this.url, {
      lazyConnect: true,
      enableAutoPipelining: false,
      maxRetriesPerRequest: null, // ioredis handles reconnect internally
    });

    this.client.on('connect', () => {
      this.isConnected = true;
      this.logger.info('Redis connected');
    });

    this.client.on('error', (err: Error) => {
      this.isConnected = false;
      this.logger.error('Redis error', err);
    });

    this.client.on('reconnecting', () => {
      this.logger.info('Redis reconnecting...');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      this.logger.info('Redis ready');
    });

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
      this.logger.info('Redis disconnected');
    }
  }

  // ─── Stream Operations ────────────────────────────────────────────────────

  async pushToStream(streamKey: string, fields: Record<string, string>): Promise<string> {
    if (!this.client || !this.isConnected) {
      throw new Error('Redis not connected');
    }
    const flatFields: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      flatFields.push(k, v);
    }
    if (flatFields.length % 2 !== 0) {
      throw new Error('Stream fields must be an even number of key-value pairs — got ' + flatFields.length);
    }
    // XADD streamKey MAXLEN ~ 100000 * field value ...
    const id = await this.client.xadd(streamKey, 'MAXLEN', '~', '100000', '*', ...flatFields);
    if (!id) throw new Error(`xadd returned null for stream "${streamKey}"`);
    return id;
  }

  async createConsumerGroup(streamKey: string, group: string): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Redis not connected');
    }
    try {
      // XGROUP CREATE streamKey group $ MKSTREAM
      await this.client.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
    } catch (err: unknown) {
      // Ignore BUSYGROUP — group already exists
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        return;
      }
      throw err;
    }
  }

  async readFromStream(
    streamKey: string,
    group: string,
    consumer: string,
    count: number,
  ): Promise<StreamMessage[]> {
    if (!this.client || !this.isConnected) {
      return [];
    }
    // XREADGROUP GROUP group consumer COUNT count BLOCK 100 STREAMS streamKey >
    const result = await this.client.xreadgroup(
      'GROUP', group, consumer,
      'COUNT', count,
      'BLOCK', 100,
      'STREAMS', streamKey, '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return [];

    const messages: StreamMessage[] = [];
    for (const [, entries] of result) {
      for (const [id, rawFields] of entries) {
        const fields: Record<string, string> = {};
        for (let i = 0; i < rawFields.length - 1; i += 2) {
          fields[rawFields[i]] = rawFields[i + 1];
        }
        messages.push({ id, fields });
      }
    }
    return messages;
  }

  async acknowledgeMessage(streamKey: string, group: string, messageId: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    await this.client.xack(streamKey, group, messageId);
  }

  async getStreamDepth(streamKey: string): Promise<number> {
    if (!this.client || !this.isConnected) return 0;
    return this.client.xlen(streamKey);
  }

  // ─── Wallet Profile ───────────────────────────────────────────────────────

  async getWalletProfile(address: string): Promise<WalletProfile | null> {
    if (!this.client || !this.isConnected) return null;
    const data = await this.client.hgetall(`wallet:${address}`);
    if (!data || Object.keys(data).length === 0) return null;

    return {
      address,
      firstTransactionTimestamp: data.first_tx_timestamp ? Number(data.first_tx_timestamp) : null,
      transactionCount: Number(data.tx_count ?? 0),
      ageHours: data.age_hours ? Number(data.age_hours) : null,
      isNew: data.is_new === 'true',
      riskScore: Number(data.risk_score ?? 0),
    };
  }

  async saveWalletProfile(profile: WalletProfile): Promise<void> {
    if (!this.client || !this.isConnected) return;
    await this.client.hset(`wallet:${profile.address}`,
      'first_tx_timestamp', profile.firstTransactionTimestamp !== null ? String(profile.firstTransactionTimestamp) : '',
      'tx_count', String(profile.transactionCount),
      'age_hours', profile.ageHours !== null ? String(profile.ageHours) : '',
      'is_new', String(profile.isNew),
      'risk_score', String(profile.riskScore),
    );
    await this.client.expire(`wallet:${profile.address}`, 86400);
  }

  // ─── Wallet Funder Cache ──────────────────────────────────────────────────

  async getWalletFunder(address: string): Promise<string | null> {
    if (!this.client || !this.isConnected) return null;
    const funder = await this.client.hget(`wallet:${address}`, 'funder');
    return funder || null;
  }

  async cacheWalletFunder(address: string, funder: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    await this.client.hset(`wallet:${address}`, 'funder', funder);
  }

  // ─── Alert Deduplication ──────────────────────────────────────────────────

  async hasAlertBeenSent(type: string, marketId: string, walletAddress: string): Promise<boolean> {
    const key = `alert:${type}:${marketId}:${walletAddress}`;
    if (!this.client || !this.isConnected) {
      return this.dedupHas(key);
    }
    const val = await this.client.get(key);
    return val !== null;
  }

  async recordSentAlert(
    type: string,
    marketId: string,
    walletAddress: string,
    ttlSeconds: number,
  ): Promise<void> {
    const key = `alert:${type}:${marketId}:${walletAddress}`;
    if (!this.client || !this.isConnected) {
      this.dedupSet(key, ttlSeconds);
      return;
    }
    await this.client.setex(key, ttlSeconds, '1');
  }

  // ─── Cluster Alert Deduplication ─────────────────────────────────────────

  async hasClusterAlertBeenSent(marketId: string, side: string): Promise<boolean> {
    const key = `cluster:${marketId}:${side}`;
    if (!this.client || !this.isConnected) {
      return this.dedupHas(key);
    }
    const val = await this.client.get(key);
    return val !== null;
  }

  async recordClusterAlert(marketId: string, side: string, ttlSeconds: number): Promise<void> {
    const key = `cluster:${marketId}:${side}`;
    if (!this.client || !this.isConnected) {
      this.dedupSet(key, ttlSeconds);
      return;
    }
    await this.client.setex(key, ttlSeconds, '1');
  }

  // ─── In-memory dedup helpers ──────────────────────────────────────────────

  private dedupHas(key: string): boolean {
    const expiry = this.dedupMap.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      // Lazy eviction of expired entry
      this.dedupMap.delete(key);
      return false;
    }
    return true;
  }

  private dedupSet(key: string, ttlSeconds: number): void {
    // Evict oldest entry on overflow to bound memory use
    if (!this.dedupMap.has(key) && this.dedupMap.size >= RedisCache.DEDUP_MAP_MAX_SIZE) {
      const oldestKey = this.dedupMap.keys().next().value;
      if (oldestKey !== undefined) this.dedupMap.delete(oldestKey);
    }
    this.dedupMap.set(key, Date.now() + ttlSeconds * 1000);
  }

  // ─── Generic Cache Operations ─────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    if (!this.client || !this.isConnected) return null;
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.client || !this.isConnected) return;
    await this.client.setex(key, ttlSeconds, value);
  }
}
