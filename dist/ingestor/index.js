"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestorService = void 0;
exports.default = main;
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const ConfigManager_1 = require("../config/ConfigManager");
const Logger_1 = require("../utils/Logger");
const RedisCache_1 = require("../cache/RedisCache");
const WebSocketManager_1 = require("../websocket/WebSocketManager");
const helpers_1 = require("../utils/helpers");
const STREAM_KEY = 'trades:stream';
const CONSUMER_GROUP = 'analyzers';
const MAX_BACKOFF_MS = 60000;
// ─── Validation ───────────────────────────────────────────────────────────────
function validateRawTrade(t) {
    if (!t.market_id || typeof t.market_id !== 'string' || t.market_id.trim() === '')
        return false;
    if (t.side !== 'YES' && t.side !== 'NO')
        return false;
    if (typeof t.price !== 'number' || t.price < 0 || t.price > 1)
        return false;
    if (typeof t.size_usd !== 'number' || t.size_usd <= 0)
        return false;
    if (typeof t.timestamp !== 'number' || !isFinite(t.timestamp) || t.timestamp <= 0)
        return false;
    if (!(0, helpers_1.isValidEthAddress)(t.maker_address))
        return false;
    if (!(0, helpers_1.isValidEthAddress)(t.taker_address))
        return false;
    return true;
}
function normalize(trade) {
    return {
        market_id: trade.market_id,
        market_name: trade.market_name,
        side: trade.side,
        price: trade.price,
        size_usd: trade.size_usd,
        timestamp: trade.timestamp,
        maker_address: trade.maker_address,
        taker_address: trade.taker_address,
        bid_liquidity: trade.order_book_depth?.bid_liquidity ?? 0,
        ask_liquidity: trade.order_book_depth?.ask_liquidity ?? 0,
    };
}
function toStreamFields(trade) {
    return {
        market_id: trade.market_id,
        market_name: trade.market_name,
        side: trade.side,
        price: String(trade.price),
        size_usd: String(trade.size_usd),
        timestamp: String(trade.timestamp),
        maker_address: trade.maker_address,
        taker_address: trade.taker_address,
        bid_liquidity: String(trade.bid_liquidity),
        ask_liquidity: String(trade.ask_liquidity),
    };
}
// ─── Fire-and-forget push with exponential backoff on Redis unavailability ────
async function pushWithRetry(redisCache, fields, logger) {
    let attempt = 0;
    while (true) {
        try {
            await redisCache.pushToStream(STREAM_KEY, fields);
            return;
        }
        catch (err) {
            logger.error('Failed to push trade to Redis stream, retrying with backoff', err, { attempt });
            await (0, helpers_1.exponentialBackoff)(attempt, MAX_BACKOFF_MS);
            attempt++;
        }
    }
}
// ─── IngestorService ──────────────────────────────────────────────────────────
class IngestorService {
    constructor() {
        this.config = new ConfigManager_1.ConfigManager();
        this.logger = new Logger_1.Logger(this.config.getLogLevel(), this.config.getLogFilePath());
        this.redisCache = new RedisCache_1.RedisCache(this.config.getRedisUrl(), this.logger);
        this.wsManager = new WebSocketManager_1.WebSocketManager(this.config.getPolymarketWsUrl(), this.logger);
    }
    async start() {
        this.logger.info('IngestorService starting');
        // Connect Redis and create consumer group (idempotent)
        await this.redisCache.connect();
        await this.redisCache.createConsumerGroup(STREAM_KEY, CONSUMER_GROUP);
        // Register trade callback
        this.wsManager.onTrade((rawTrade) => {
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
        this.wsManager.onError((err) => {
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
    async stop() {
        this.logger.info('IngestorService stopping');
        this.wsManager.disconnect();
        await this.redisCache.disconnect();
        this.logger.info('IngestorService stopped');
    }
    async getStreamDepth() {
        return this.redisCache.getStreamDepth(STREAM_KEY);
    }
}
exports.IngestorService = IngestorService;
// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
    const service = new IngestorService();
    await service.start();
}
main().catch((err) => {
    console.error('Fatal error in ingestor:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map