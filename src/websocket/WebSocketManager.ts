import WebSocket from 'ws';
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
// Total token cap per connection — server rejects subscriptions beyond this
const MAX_TOTAL_TOKENS = 2000;

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string[];
  tags?: Array<{ label?: string; slug?: string }>;
  category?: string;
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

  private tradeCallback: TradeCallback | null = null;
  private errorCallback: ErrorCallback | null = null;
  private reconnectCallback: ReconnectCallback | null = null;

  // market conditionId → question title
  private marketNames = new Map<string, string>();
  // market conditionId → category
  private marketCategories = new Map<string, string>();
  // token assetId → conditionId
  private tokenToMarket = new Map<string, string>();
  private tokenIds: string[] = [];

  private reconnectAttempt = 0;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private marketRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = true;

  constructor(url: string, logger: Logger) {
    this.url = url;
    this.logger = logger;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  onTrade(callback: TradeCallback): void { this.tradeCallback = callback; }
  onError(callback: ErrorCallback): void { this.errorCallback = callback; }
  onReconnect(callback: ReconnectCallback): void { this.reconnectCallback = callback; }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    await this._fetchMarkets();
    await this._connect();
    this._startMarketRefresh();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this._clearTimers();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.tradeCallback = null;
    this.errorCallback = null;
    this.reconnectCallback = null;
    this.logger.info('WebSocketManager disconnected');
  }

  // ─── Market fetch ──────────────────────────────────────────────────────────

  /** Fetches the market list and returns any token IDs not previously known. */
  private async _fetchMarkets(): Promise<string[]> {
    this.logger.info('Fetching active markets from Gamma API');
    try {
      const response = await fetch(GAMMA_API);
      if (!response.ok) {
        this.logger.warn('Gamma API fetch failed, continuing without market names', { status: response.status });
        return [];
      }
      const markets: GammaMarket[] = await response.json() as GammaMarket[];
      const previousTokenIds = new Set(this.tokenIds);

      this.marketNames.clear();
      this.tokenToMarket.clear();
      this.tokenIds = [];

      for (const m of markets) {
        if (!m.clobTokenIds?.length) continue;
        this.marketNames.set(m.conditionId, m.question ?? m.conditionId);
        // Derive category from tags array or top-level category field
        const category = m.category ?? m.tags?.[0]?.slug ?? m.tags?.[0]?.label;
        if (category) this.marketCategories.set(m.conditionId, category.toLowerCase());
        for (const tid of m.clobTokenIds) {
          this.tokenToMarket.set(tid, m.conditionId);
          this.tokenIds.push(tid);
        }
      }
      this.logger.info('Markets loaded', { count: this.marketNames.size, tokens: this.tokenIds.length });

      return this.tokenIds.filter(tid => !previousTokenIds.has(tid));
    } catch (err) {
      this.logger.warn('Gamma API fetch failed, continuing without market names', { error: String(err) });
      return [];
    }
  }

  // ─── Periodic market refresh ───────────────────────────────────────────────

  private _startMarketRefresh(): void {
    if (this.marketRefreshTimer !== null) return;
    this.marketRefreshTimer = setInterval(async () => {
      const newTokenIds = await this._fetchMarkets();
      if (newTokenIds.length === 0) return;

      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Subscribe only to the newly discovered tokens
      const tokens = newTokenIds.slice(0, MAX_TOTAL_TOKENS - (this.tokenIds.length - newTokenIds.length));
      if (tokens.length === 0) return;

      ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' }));
      this.logger.info('Market refresh: subscribed to new tokens', { newTokenCount: tokens.length });
    }, 6 * 60 * 60 * 1000); // every 6 hours
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    this.logger.info('WebSocketManager connecting', { url: this.url, attempt: this.reconnectAttempt });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.logger.error('WebSocket constructor threw', err instanceof Error ? err : new Error(String(err)));
      if (this.shouldReconnect) this._scheduleReconnect();
      return;
    }
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
      try {
        this._subscribe(ws);
      } catch (err) {
        this.logger.error('WebSocket _subscribe threw', err instanceof Error ? err : new Error(String(err)));
      }
      this._startPing(ws);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this._handleMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.logger.error('WebSocket error', err);
      this.errorCallback?.(err);
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

    // Polymarket server accepts only ONE subscription message with all tokens
    // Limit to MAX_TOTAL_TOKENS to avoid rejection
    const tokens = this.tokenIds.slice(0, MAX_TOTAL_TOKENS);
    
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
        this.tradeCallback?.(trade);
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
    const marketCategory = this.marketCategories.get(conditionId);

    // Polymarket CLOB WS does not expose wallet addresses on the market channel.
    // Addresses are omitted here; wallet profiling happens via Alchemy on the analyzer side.

    return {
      market_id: conditionId,
      market_name: marketName,
      side: e.side === 'BUY' ? 'YES' : 'NO',
      price,
      size,
      // size is the raw share quantity from the WS event (not guaranteed USDC).
      // On Polymarket CLOB, price is in USDC/share, so size * price gives the USDC notional.
      // This assumption holds for standard CLOB markets but may not apply to exotic contract types.
      size_usd: size * price,
      timestamp,
      order_book_depth: { bid_liquidity: 0, ask_liquidity: 0 },
      market_category: marketCategory,
    };
  }

  // ─── Reconnect ─────────────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    this.reconnectCallback?.();
    (async () => {
      try {
        await exponentialBackoff(this.reconnectAttempt, MAX_RECONNECT_DELAY);
        this.reconnectAttempt++;
        this.logger.info('WebSocket reconnecting', { attempt: this.reconnectAttempt });
        // Refresh market list on reconnect
        await this._fetchMarkets();
        await this._connect();
      } catch (err) {
        this.logger.error('WebSocket reconnect failed', err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  private _clearTimers(): void {
    this._clearConnectionTimer();
    this._stopPing();
    if (this.marketRefreshTimer !== null) {
      clearInterval(this.marketRefreshTimer);
      this.marketRefreshTimer = null;
    }
  }

  private _clearConnectionTimer(): void {
    if (this.connectionTimer !== null) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }
}
