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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketManager = void 0;
const ws_1 = __importDefault(require("ws"));
const https = __importStar(require("https"));
const helpers_1 = require("../utils/helpers");
const MAX_RECONNECT_DELAY = 60000;
const CONNECTION_TIMEOUT_MS = 30000;
const PING_INTERVAL_MS = 10000;
// Fetch top markets sorted by 24h volume — ensures we monitor the most active ones
const GAMMA_API = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false';
// Total token cap per connection — server rejects subscriptions beyond this
const MAX_TOTAL_TOKENS = 2000;
class WebSocketManager {
    constructor(url, logger) {
        this.ws = null;
        this.tradeCallbacks = [];
        this.errorCallbacks = [];
        this.reconnectCallbacks = [];
        // market conditionId → question title
        this.marketNames = new Map();
        // token assetId → conditionId
        this.tokenToMarket = new Map();
        this.tokenIds = [];
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.connectionTimer = null;
        this.pingTimer = null;
        this.shouldReconnect = true;
        this.url = url;
        this.logger = logger;
    }
    // ─── Public API ────────────────────────────────────────────────────────────
    onTrade(callback) { this.tradeCallbacks.push(callback); }
    onError(callback) { this.errorCallbacks.push(callback); }
    onReconnect(callback) { this.reconnectCallbacks.push(callback); }
    isConnected() {
        return this.ws !== null && this.ws.readyState === ws_1.default.OPEN;
    }
    async connect() {
        this.shouldReconnect = true;
        this.reconnectAttempt = 0;
        await this._fetchMarkets();
        await this._connect();
    }
    disconnect() {
        this.shouldReconnect = false;
        this._clearTimers();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.logger.info('WebSocketManager disconnected');
    }
    // ─── Market fetch ──────────────────────────────────────────────────────────
    _fetchMarkets() {
        return new Promise((resolve) => {
            this.logger.info('Fetching active markets from Gamma API');
            https.get(GAMMA_API, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const markets = JSON.parse(body);
                        this.marketNames.clear();
                        this.tokenToMarket.clear();
                        this.tokenIds = [];
                        for (const m of markets) {
                            if (!m.clobTokenIds?.length)
                                continue;
                            this.marketNames.set(m.conditionId, m.question ?? m.conditionId);
                            for (const tid of m.clobTokenIds) {
                                this.tokenToMarket.set(tid, m.conditionId);
                                this.tokenIds.push(tid);
                            }
                        }
                        this.logger.info('Markets loaded', { count: this.marketNames.size, tokens: this.tokenIds.length });
                    }
                    catch (err) {
                        this.logger.warn('Failed to parse Gamma API response, will retry on reconnect', { error: String(err) });
                    }
                    resolve();
                });
            }).on('error', (err) => {
                this.logger.warn('Gamma API fetch failed, continuing without market names', { error: err.message });
                resolve();
            });
        });
    }
    // ─── Connection ────────────────────────────────────────────────────────────
    async _connect() {
        this.logger.info('WebSocketManager connecting', { url: this.url, attempt: this.reconnectAttempt });
        const ws = new ws_1.default(this.url);
        this.ws = ws;
        this.connectionTimer = setTimeout(() => {
            if (ws.readyState !== ws_1.default.OPEN) {
                this.logger.warn('WebSocket connection timeout', { attempt: this.reconnectAttempt });
                ws.terminate();
            }
        }, CONNECTION_TIMEOUT_MS);
        ws.on('open', () => {
            this._clearConnectionTimer();
            this.reconnectAttempt = 0;
            this.logger.info('WebSocket connected');
            this._subscribe(ws);
            this._startPing(ws);
        });
        ws.on('message', (data) => {
            this._handleMessage(data);
        });
        ws.on('error', (err) => {
            this.logger.error('WebSocket error', err);
            for (const cb of this.errorCallbacks)
                cb(err);
        });
        ws.on('close', () => {
            this._clearConnectionTimer();
            this._stopPing();
            this.logger.warn('WebSocket closed');
            if (this.shouldReconnect)
                this._scheduleReconnect();
        });
    }
    // ─── Subscription ──────────────────────────────────────────────────────────
    _subscribe(ws) {
        if (this.tokenIds.length === 0) {
            this.logger.warn('No token IDs to subscribe to — no trades will be received');
            return;
        }
        // Server only accepts a single subscription message — send all tokens at once
        const tokens = this.tokenIds.slice(0, MAX_TOTAL_TOKENS);
        const msg = JSON.stringify({
            assets_ids: tokens,
            type: 'market',
        });
        ws.send(msg);
        this.logger.info('Subscribed to market channel', { tokenCount: tokens.length });
    }
    // ─── Heartbeat ─────────────────────────────────────────────────────────────
    _startPing(ws) {
        this._stopPing();
        this.pingTimer = setInterval(() => {
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send('PING');
            }
        }, PING_INTERVAL_MS);
    }
    _stopPing() {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
    // ─── Message parsing ───────────────────────────────────────────────────────
    _handleMessage(data) {
        const raw = data.toString();
        // Server heartbeat response
        if (raw === 'PONG')
            return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            this.logger.warn('WebSocket malformed JSON', { data: raw.slice(0, 200) });
            return;
        }
        // Messages can be arrays or single objects
        const events = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of events) {
            this._handleEvent(event);
        }
    }
    _handleEvent(event) {
        if (!event || typeof event !== 'object')
            return;
        const e = event;
        if (e['event_type'] === 'last_trade_price') {
            this.logger.debug('WebSocket last_trade_price received', {
                asset_id: String(e['asset_id']).slice(0, 20) + '...',
                price: e['price'],
                size: e['size'],
                side: e['side'],
            });
            const trade = this._parseLastTradePrice(e);
            if (trade) {
                for (const cb of this.tradeCallbacks)
                    cb(trade);
            }
        }
        // book (no event_type), price_change, best_bid_ask, new_market, market_resolved — ignored
    }
    _parseLastTradePrice(e) {
        const price = parseFloat(e.price);
        const size = parseFloat(e.size);
        const timestamp = parseInt(e.timestamp, 10);
        if (isNaN(price) || isNaN(size) || isNaN(timestamp)) {
            this.logger.warn('last_trade_price: invalid numeric fields', { event: e });
            return null;
        }
        const conditionId = this.tokenToMarket.get(e.asset_id) ?? e.market ?? e.asset_id;
        const marketName = this.marketNames.get(conditionId) ?? conditionId;
        // Polymarket CLOB WS does not expose wallet addresses on the market channel.
        // We use the asset_id as a deterministic placeholder so downstream validation passes.
        // Real wallet profiling happens via Alchemy on the analyzer side.
        const placeholder = `0x${'0'.repeat(40)}`;
        return {
            market_id: conditionId,
            market_name: marketName,
            side: e.side === 'BUY' ? 'YES' : 'NO',
            price,
            size,
            size_usd: size * price, // size is in shares; multiply by price to get USDC value
            timestamp,
            maker_address: placeholder,
            taker_address: placeholder,
            order_book_depth: { bid_liquidity: 0, ask_liquidity: 0 },
        };
    }
    // ─── Reconnect ─────────────────────────────────────────────────────────────
    _scheduleReconnect() {
        for (const cb of this.reconnectCallbacks)
            cb();
        this.reconnectTimer = setTimeout(async () => {
            this.logger.info('WebSocket reconnecting', { attempt: this.reconnectAttempt });
            await (0, helpers_1.exponentialBackoff)(this.reconnectAttempt, MAX_RECONNECT_DELAY);
            this.reconnectAttempt++;
            // Refresh market list on reconnect
            await this._fetchMarkets();
            await this._connect();
        }, 0);
    }
    _clearTimers() {
        this._clearConnectionTimer();
        this._stopPing();
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    _clearConnectionTimer() {
        if (this.connectionTimer !== null) {
            clearTimeout(this.connectionTimer);
            this.connectionTimer = null;
        }
    }
}
exports.WebSocketManager = WebSocketManager;
//# sourceMappingURL=WebSocketManager.js.map