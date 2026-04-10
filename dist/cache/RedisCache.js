"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCache = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
class RedisCache {
    constructor(url, logger) {
        this.client = null;
        this.isConnected = false;
        // In-memory fallback for alert dedup when Redis is unavailable
        this.dedupMap = new Map();
        this.url = url;
        this.logger = logger;
    }
    async connect() {
        this.client = new ioredis_1.default(this.url, {
            lazyConnect: true,
            enableAutoPipelining: false,
            maxRetriesPerRequest: null, // ioredis handles reconnect internally
        });
        this.client.on('connect', () => {
            this.isConnected = true;
            this.logger.info('Redis connected');
        });
        this.client.on('error', (err) => {
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
    async disconnect() {
        if (this.client) {
            await this.client.quit();
            this.isConnected = false;
            this.logger.info('Redis disconnected');
        }
    }
    // ─── Stream Operations ────────────────────────────────────────────────────
    async pushToStream(streamKey, fields) {
        if (!this.client || !this.isConnected) {
            throw new Error('Redis not connected');
        }
        const flatFields = [];
        for (const [k, v] of Object.entries(fields)) {
            flatFields.push(k, v);
        }
        // XADD streamKey MAXLEN ~ 100000 * field value ...
        const id = await this.client.xadd(streamKey, 'MAXLEN', '~', '100000', '*', ...flatFields);
        return id;
    }
    async createConsumerGroup(streamKey, group) {
        if (!this.client || !this.isConnected) {
            throw new Error('Redis not connected');
        }
        try {
            // XGROUP CREATE streamKey group $ MKSTREAM
            await this.client.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
        }
        catch (err) {
            // Ignore BUSYGROUP — group already exists
            if (err instanceof Error && err.message.includes('BUSYGROUP')) {
                return;
            }
            throw err;
        }
    }
    async readFromStream(streamKey, group, consumer, count) {
        if (!this.client || !this.isConnected) {
            return [];
        }
        // XREADGROUP GROUP group consumer COUNT count BLOCK 100 STREAMS streamKey >
        const result = await this.client.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'BLOCK', 100, 'STREAMS', streamKey, '>');
        if (!result)
            return [];
        const messages = [];
        for (const [, entries] of result) {
            for (const [id, rawFields] of entries) {
                const fields = {};
                for (let i = 0; i < rawFields.length - 1; i += 2) {
                    fields[rawFields[i]] = rawFields[i + 1];
                }
                messages.push({ id, fields });
            }
        }
        return messages;
    }
    async acknowledgeMessage(streamKey, group, messageId) {
        if (!this.client || !this.isConnected)
            return;
        await this.client.xack(streamKey, group, messageId);
    }
    async getStreamDepth(streamKey) {
        if (!this.client || !this.isConnected)
            return 0;
        return this.client.xlen(streamKey);
    }
    // ─── Wallet Profile ───────────────────────────────────────────────────────
    async getWalletProfile(address) {
        if (!this.client || !this.isConnected)
            return null;
        const data = await this.client.hgetall(`wallet:${address}`);
        if (!data || Object.keys(data).length === 0)
            return null;
        return {
            address,
            firstTransactionTimestamp: data.first_tx_timestamp ? Number(data.first_tx_timestamp) : null,
            transactionCount: Number(data.tx_count ?? 0),
            ageHours: data.age_hours ? Number(data.age_hours) : null,
            isNew: data.is_new === 'true',
            riskScore: Number(data.risk_score ?? 0),
        };
    }
    async saveWalletProfile(profile) {
        if (!this.client || !this.isConnected)
            return;
        await this.client.hset(`wallet:${profile.address}`, 'first_tx_timestamp', profile.firstTransactionTimestamp !== null ? String(profile.firstTransactionTimestamp) : '', 'tx_count', String(profile.transactionCount), 'age_hours', profile.ageHours !== null ? String(profile.ageHours) : '', 'is_new', String(profile.isNew), 'risk_score', String(profile.riskScore));
    }
    // ─── Wallet Funder Cache ──────────────────────────────────────────────────
    async getWalletFunder(address) {
        if (!this.client || !this.isConnected)
            return null;
        const funder = await this.client.hget(`wallet:${address}`, 'funder');
        return funder || null;
    }
    async cacheWalletFunder(address, funder) {
        if (!this.client || !this.isConnected)
            return;
        await this.client.hset(`wallet:${address}`, 'funder', funder);
    }
    // ─── Alert Deduplication ──────────────────────────────────────────────────
    async hasAlertBeenSent(type, marketId, walletAddress) {
        const key = `alert:${type}:${marketId}:${walletAddress}`;
        if (!this.client || !this.isConnected) {
            return this.dedupMap.get(key) === true;
        }
        const val = await this.client.get(key);
        return val !== null;
    }
    async recordSentAlert(type, marketId, walletAddress, ttlSeconds) {
        const key = `alert:${type}:${marketId}:${walletAddress}`;
        if (!this.client || !this.isConnected) {
            this.dedupMap.set(key, true);
            return;
        }
        await this.client.setex(key, ttlSeconds, '1');
    }
    // ─── Cluster Alert Deduplication ─────────────────────────────────────────
    async hasClusterAlertBeenSent(marketId, side) {
        const key = `cluster:${marketId}:${side}`;
        if (!this.client || !this.isConnected) {
            return this.dedupMap.get(key) === true;
        }
        const val = await this.client.get(key);
        return val !== null;
    }
    async recordClusterAlert(marketId, side, ttlSeconds) {
        const key = `cluster:${marketId}:${side}`;
        if (!this.client || !this.isConnected) {
            this.dedupMap.set(key, true);
            return;
        }
        await this.client.setex(key, ttlSeconds, '1');
    }
}
exports.RedisCache = RedisCache;
//# sourceMappingURL=RedisCache.js.map