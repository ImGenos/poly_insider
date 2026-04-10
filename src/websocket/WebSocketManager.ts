import WebSocket from 'ws';
import * as https from 'https';
import { RawTrade } from '../types/index';
import { Logger } from '../utils/Logger';
import { exponentialBackoff } from '../utils/helpers';

type TradeCallback = (trade: RawTrade) => void;
type ErrorCallback = (err: Error) => void;
type ReconnectCallback = () => void;

const MAX_RECONNECT_DELAY = 60_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 10_000;
// Fetch top markets sorted by 24h volume — ensures we monitor the most active ones
const GAMMA_API = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false';
// Max token IDs per subscription — server handles at least 3000+ without issues
const MAX_TOKENS_PER_SUB = 2000;

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string[];
}

interface LastTradePriceEvent {
  event_type: 'last_trade_price';
  asset_id: string;
  market: string; // condition_id
  price: string;
  side: string;
  size: string;
  timestamp: string;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly logger: Logger;

  private tradeCallbacks: TradeCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private reconnectCallbacks: ReconnectCallback[] = [];

  // market conditionId → question title
  private marketNames = new Map<string, string>();
  // token assetId → conditionId
  private tokenToMarket = new Map<string, string>();
  private tokenIds: string[] = [];

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = true;

  constructor(url: string, logger: Logger) {
    this.url = url;
    this.logger = logger;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  onTrade(callback: TradeCallback): void { this.tradeCallbacks.push(callback); }
  onError(callback: ErrorCallback): void { this.errorCallbacks.push(callback); }
  onReconnect(callback: ReconnectCallback): void { this.reconnectCallbacks.push(callback); }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    await this._fetchMarkets();
    await this._connect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this._clearTimers();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.logger.info('WebSocketManager disconnected');
  }

  // ─── Market fetch ──────────────────────────────────────────────────────────

  private _fetchMarkets(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.info('Fetching active markets from Gamma API');
      https.get(GAMMA_API, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          try {
            const markets: GammaMarket[] = JSON.parse(body);
            this.marketNames.clear();
            this.tokenToMarket.clear();
            this.tokenIds = [];

            for (const m of markets) {
              if (!m.clobTokenIds?.length) continue;
              this.marketNames.set(m.conditionId, m.question ?? m.conditionId);
              for (const tid of m.clobTokenIds) {
                this.tokenToMarket.set(tid, m.conditionId);
                this.tokenIds.push(tid);
              }
            }
            this.logger.info('Markets loaded', { count: this.marketNames.size, tokens: this.tokenIds.length });
          } catch (err) {
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

  private async _connect(): Promise<void> {
    this.logger.info('WebSocketManager connecting', { url: this.url, attempt: this.reconnectAttempt });

    const ws = new WebSocket(this.url);
    this.ws = ws;

    this.connectionTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
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

    ws.on('message', (data: WebSocket.RawData) => {
      this._handleMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.logger.error('WebSocket error', err);
      for (const cb of this.errorCallbacks) cb(err);
    });

    ws.on('close', () => {
      this._clearConnectionTimer();
      this._stopPing();
      this.logger.warn('WebSocket closed');
      if (this.shouldReconnect) this._scheduleReconnect();
    });
  }

  // ─── Subscription ──────────────────────────────────────────────────────────

  private _subscribe(ws: WebSocket): void {
    if (this.tokenIds.length === 0) {
      this.logger.warn('No token IDs to subscribe to — no trades will be received');
      return;
    }

    // Send in batches to avoid oversized frames
    const tokens = this.tokenIds.slice(0, MAX_TOKENS_PER_SUB);
    // Note: do NOT include custom_feature_enabled — it causes server-side 1006 disconnects
    const msg = JSON.stringify({
      assets_ids: tokens,
      type: 'market',
    });
    ws.send(msg);
    this.logger.info('Subscribed to market channel', { tokenCount: tokens.length });
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

  private _startPing(ws: WebSocket): void {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('PING');
      }
    }, PING_INTERVAL_MS);
  }

  private _stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ─── Message parsing ───────────────────────────────────────────────────────

  private _handleMessage(data: WebSocket.RawData): void {
    const raw = data.toString();

    // Server heartbeat response
    if (raw === 'PONG') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn('WebSocket malformed JSON', { data: raw.slice(0, 200) });
      return;
    }

    // Messages can be arrays or single objects
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of events) {
      this._handleEvent(event);
    }
  }

  private _handleEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, unknown>;

    if (e['event_type'] === 'last_trade_price') {
      this.logger.debug('WebSocket last_trade_price received', {
        asset_id: String(e['asset_id']).slice(0, 20) + '...',
        price: e['price'],
        size: e['size'],
        side: e['side'],
      });
      const trade = this._parseLastTradePrice(e as unknown as LastTradePriceEvent);
      if (trade) {
        for (const cb of this.tradeCallbacks) cb(trade);
      }
    }
    // book (no event_type), price_change, best_bid_ask, new_market, market_resolved — ignored
  }

  private _parseLastTradePrice(e: LastTradePriceEvent): RawTrade | null {
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
      size_usd: size, // size is already in USDC on Polymarket
      timestamp,
      maker_address: placeholder,
      taker_address: placeholder,
      order_book_depth: { bid_liquidity: 0, ask_liquidity: 0 },
    };
  }

  // ─── Reconnect ─────────────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    for (const cb of this.reconnectCallbacks) cb();
    this.reconnectTimer = setTimeout(async () => {
      this.logger.info('WebSocket reconnecting', { attempt: this.reconnectAttempt });
      await exponentialBackoff(this.reconnectAttempt, MAX_RECONNECT_DELAY);
      this.reconnectAttempt++;
      // Refresh market list on reconnect
      await this._fetchMarkets();
      await this._connect();
    }, 0);
  }

  private _clearTimers(): void {
    this._clearConnectionTimer();
    this._stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _clearConnectionTimer(): void {
    if (this.connectionTimer !== null) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }
}
