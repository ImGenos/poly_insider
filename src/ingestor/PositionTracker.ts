/**
 * PositionTracker
 *
 * Detects large positions built gradually through limit orders — trades that
 * never appear in the WebSocket `last_trade_price` stream because they are
 * passive maker fills, not aggressive taker crosses.
 *
 * Strategy
 * ────────
 * 1. Every POLL_INTERVAL_MS, fetch the top-N most active markets from Gamma API.
 * 2. For each market, call the Data API `/trades` endpoint filtered by the last
 *    known cursor so only *new* trades are returned.
 * 3. Aggregate trades per wallet over a rolling ACCUMULATION_WINDOW_MS window.
 * 4. When a wallet's accumulated position crosses ACCUMULATION_THRESHOLD_USDC,
 *    emit a synthetic RawTrade so the existing analyzer pipeline (AnomalyDetector,
 *    Telegram, TimescaleDB) handles it without any changes.
 *
 * The emitted trade has:
 *   - side: the dominant side accumulated
 *   - size_usd: total USDC accumulated in the window
 *   - market_category: 'accumulation' (so InsiderDetector skip-list works)
 *   - taker_address: the wallet that accumulated
 */

import https from 'https';
import { Logger } from '../utils/Logger';
import { RawTrade } from '../types/index';

// ─── Public configuration ─────────────────────────────────────────────────────

export interface PositionTrackerConfig {
  /** How often to poll for new trades, ms. Default 30 000 (30 s). */
  pollIntervalMs?: number;
  /** Rolling window to sum trades per wallet, ms. Default 14 400 000 (4 h). */
  accumulationWindowMs?: number;
  /** USDC accumulated in the window to emit an alert. Default 20 000. */
  accumulationThresholdUsdc?: number;
  /** How many top markets to track. Default 50. */
  topMarketsCount?: number;
  /** Minimum individual trade size to consider (noise filter), USDC. Default 500. */
  minTradeSizeUsdc?: number;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface DataAPITrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  conditionId: string;
  slug?: string;
  title: string;
  size: number;
  price: number;
  timestamp: number;  // Unix seconds
  outcome?: string;
}

interface AccumulationBucket {
  walletAddress: string;
  marketId: string;
  marketName: string;
  side: 'YES' | 'NO';
  trades: Array<{ sizeUsd: number; timestampMs: number; price: number }>;
  totalSizeUsd: number;
  alertedAt: number | null;   // timestamp when last alert was emitted
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class PositionTracker {
  private readonly logger: Logger;

  // Config with defaults applied
  private readonly pollIntervalMs: number;
  private readonly accumulationWindowMs: number;
  private readonly accumulationThresholdUsdc: number;
  private readonly topMarketsCount: number;
  private readonly minTradeSizeUsdc: number;

  // State
  private timer: NodeJS.Timeout | null = null;
  private tradeCallback: ((trade: RawTrade) => void) | null = null;

  /**
   * Per-market cursor: last trade timestamp (seconds) already seen.
   * We filter API results with `since=<cursor>` to avoid reprocessing.
   */
  private marketCursors = new Map<string, number>();

  /**
   * Accumulation state keyed by `${walletAddress}:${marketId}:${side}`.
   */
  private buckets = new Map<string, AccumulationBucket>();

  /**
   * Cached list of top market slugs / condition IDs from Gamma API.
   * Refreshed every MARKET_REFRESH_EVERY polls.
   */
  private topMarkets: Array<{ conditionId: string; slug: string; title: string; volume24h: number }> = [];
  private marketRefreshCounter = 0;
  private static readonly MARKET_REFRESH_EVERY = 10;  // refresh market list every N polls

  constructor(logger: Logger, config: PositionTrackerConfig = {}) {
    this.logger = logger;
    this.pollIntervalMs          = config.pollIntervalMs          ?? 30_000;
    this.accumulationWindowMs    = config.accumulationWindowMs    ?? 4 * 60 * 60 * 1000;
    this.accumulationThresholdUsdc = config.accumulationThresholdUsdc ?? 20_000;
    this.topMarketsCount         = config.topMarketsCount         ?? 50;
    this.minTradeSizeUsdc        = config.minTradeSizeUsdc        ?? 500;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  onTrade(callback: (trade: RawTrade) => void): void {
    this.tradeCallback = callback;
  }

  start(): void {
    this.logger.info('PositionTracker starting', {
      pollIntervalMs: this.pollIntervalMs,
      accumulationWindowMs: this.accumulationWindowMs,
      thresholdUsdc: this.accumulationThresholdUsdc,
      topMarketsCount: this.topMarketsCount,
    });

    // First poll immediately, then on interval
    this._poll().catch(err => this.logger.error('PositionTracker: initial poll failed', err));
    this.timer = setInterval(() => {
      this._poll().catch(err => this.logger.error('PositionTracker: poll failed', err));
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('PositionTracker stopped');
  }

  // ─── Poll cycle ──────────────────────────────────────────────────────────────

  private async _poll(): Promise<void> {
    // Refresh market list periodically
    if (this.marketRefreshCounter === 0 || this.topMarkets.length === 0) {
      await this._refreshTopMarkets();
    }
    this.marketRefreshCounter = (this.marketRefreshCounter + 1) % PositionTracker.MARKET_REFRESH_EVERY;

    if (this.topMarkets.length === 0) {
      this.logger.warn('PositionTracker: no markets to track');
      return;
    }

    // Evict expired accumulation entries before processing new data
    this._evictExpiredBuckets();

    // Fetch new trades for each tracked market in serial to stay within API rate limits
    for (const market of this.topMarkets) {
      try {
        await this._pollMarket(market);
      } catch (err) {
        this.logger.warn('PositionTracker: error polling market', {
          marketId: market.conditionId,
          error: String(err),
        });
      }
    }
  }

  // ─── Market-level polling ─────────────────────────────────────────────────

  private async _pollMarket(market: {
    conditionId: string;
    slug: string;
    title: string;
  }): Promise<void> {
    const cursor = this.marketCursors.get(market.conditionId) ?? 0;
    const trades = await this._fetchTrades(market.conditionId, cursor);

    if (trades.length === 0) return;

    this.logger.debug('PositionTracker: fetched trades', {
      marketId: market.conditionId,
      count: trades.length,
    });

    // Update cursor to the latest timestamp seen
    const latestTs = Math.max(...trades.map(t => t.timestamp));
    this.marketCursors.set(market.conditionId, latestTs);

    // Process each trade into the accumulation buckets
    for (const trade of trades) {
      const sizeUsd = trade.side === 'BUY'
        ? trade.size * trade.price
        : trade.size * (1 - trade.price);

      if (sizeUsd < this.minTradeSizeUsdc) continue;
      if (!trade.proxyWallet) continue;

      const side: 'YES' | 'NO' = trade.side === 'BUY' ? 'YES' : 'NO';
      const key = `${trade.proxyWallet}:${market.conditionId}:${side}`;

      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = {
          walletAddress: trade.proxyWallet,
          marketId: market.slug ?? market.conditionId,
          marketName: market.title,
          side,
          trades: [],
          totalSizeUsd: 0,
          alertedAt: null,
        };
        this.buckets.set(key, bucket);
      }

      bucket.trades.push({
        sizeUsd,
        timestampMs: trade.timestamp * 1000,
        price: trade.price,
      });
      bucket.totalSizeUsd += sizeUsd;

      // Check threshold
      this._checkBucket(bucket);
    }
  }

  // ─── Threshold check & alert emission ────────────────────────────────────

  private _checkBucket(bucket: AccumulationBucket): void {
    const now = Date.now();

    // Recompute total within window (evict old entries)
    const windowStart = now - this.accumulationWindowMs;
    bucket.trades = bucket.trades.filter(t => t.timestampMs >= windowStart);
    bucket.totalSizeUsd = bucket.trades.reduce((s, t) => s + t.sizeUsd, 0);

    if (bucket.totalSizeUsd < this.accumulationThresholdUsdc) return;

    // Rate-limit: don't re-alert for the same bucket within one accumulation window
    if (bucket.alertedAt !== null && now - bucket.alertedAt < this.accumulationWindowMs) return;

    bucket.alertedAt = now;

    const avgPrice = bucket.trades.length > 0
      ? bucket.trades.reduce((s, t) => s + t.price, 0) / bucket.trades.length
      : 0.5;

    const syntheticTrade: RawTrade = {
      market_id: bucket.marketId,
      market_name: bucket.marketName,
      side: bucket.side,
      price: avgPrice,
      size: bucket.totalSizeUsd / Math.max(avgPrice, 0.001),
      size_usd: bucket.totalSizeUsd,
      timestamp: now,
      taker_address: bucket.walletAddress,
      order_book_depth: { bid_liquidity: 0, ask_liquidity: 0 },
      market_category: 'accumulation',
    };

    this.logger.info('PositionTracker: accumulation threshold crossed', {
      wallet: bucket.walletAddress.slice(0, 10) + '...',
      marketId: bucket.marketId,
      side: bucket.side,
      totalSizeUsd: bucket.totalSizeUsd.toFixed(0),
      tradeCount: bucket.trades.length,
      windowHours: (this.accumulationWindowMs / 3_600_000).toFixed(1),
    });

    this.tradeCallback?.(syntheticTrade);
  }

  // ─── Eviction ─────────────────────────────────────────────────────────────

  private _evictExpiredBuckets(): void {
    const windowStart = Date.now() - this.accumulationWindowMs;
    let evicted = 0;

    for (const [key, bucket] of this.buckets.entries()) {
      const active = bucket.trades.filter(t => t.timestampMs >= windowStart);
      if (active.length === 0) {
        this.buckets.delete(key);
        evicted++;
      } else {
        bucket.trades = active;
        bucket.totalSizeUsd = active.reduce((s, t) => s + t.sizeUsd, 0);
      }
    }

    if (evicted > 0) {
      this.logger.debug('PositionTracker: evicted expired buckets', { evicted });
    }
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private _fetchTrades(conditionId: string, since: number): Promise<DataAPITrade[]> {
    return new Promise((resolve, reject) => {
      // since=0 means "fetch last 200 trades" on first run; subsequent calls use the cursor
      const sinceParam = since > 0 ? `&since=${since}` : '';
      const path = `/trades?conditionId=${conditionId}&limit=200&takerOnly=false${sinceParam}`;

      const options: https.RequestOptions = {
        hostname: 'data-api.polymarket.com',
        path,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 8_000,
      };

      const req = https.request(options, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            reject(new Error(`PositionTracker: JSON parse error for market ${conditionId}: ${e}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('PositionTracker: request timeout')); });
      req.end();
    });
  }

  private _fetchTopMarkets(): Promise<Array<{
    conditionId: string;
    slug: string;
    title: string;
    volume24h: number;
  }>> {
    return new Promise((resolve, reject) => {
      const path = `/markets?active=true&closed=false&limit=${this.topMarketsCount}&order=volume24hr&ascending=false`;

      const options: https.RequestOptions = {
        hostname: 'gamma-api.polymarket.com',
        path,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 8_000,
      };

      const req = https.request(options, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as Array<{
              conditionId?: string;
              condition_id?: string;
              slug?: string;
              question?: string;
              title?: string;
              volume?: number;
              volume24hr?: number;
            }>;
            const markets = Array.isArray(parsed) ? parsed : [];
            resolve(markets.map(m => ({
              conditionId: m.conditionId ?? m.condition_id ?? '',
              slug: m.slug ?? m.conditionId ?? m.condition_id ?? '',
              title: m.question ?? m.title ?? m.slug ?? '',
              volume24h: m.volume24hr ?? m.volume ?? 0,
            })).filter(m => m.conditionId));
          } catch (e) {
            reject(new Error(`PositionTracker: Gamma API parse error: ${e}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('PositionTracker: Gamma API timeout')); });
      req.end();
    });
  }

  private async _refreshTopMarkets(): Promise<void> {
    try {
      this.topMarkets = await this._fetchTopMarkets();
      this.logger.info('PositionTracker: top markets refreshed', { count: this.topMarkets.length });
    } catch (err) {
      this.logger.warn('PositionTracker: failed to refresh top markets', { error: String(err) });
    }
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  /** Returns a summary of the current accumulation state. Useful for tests and monitoring. */
  getState(): {
    trackedMarkets: number;
    activeBuckets: number;
    topBuckets: Array<{ key: string; totalSizeUsd: number; tradeCount: number }>;
  } {
    const sorted = [...this.buckets.entries()]
      .map(([k, b]) => ({ key: k, totalSizeUsd: b.totalSizeUsd, tradeCount: b.trades.length }))
      .sort((a, b) => b.totalSizeUsd - a.totalSizeUsd)
      .slice(0, 5);

    return {
      trackedMarkets: this.topMarkets.length,
      activeBuckets: this.buckets.size,
      topBuckets: sorted,
    };
  }
}
