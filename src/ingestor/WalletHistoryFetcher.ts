/**
 * WalletHistoryFetcher
 *
 * Fetches the complete Polymarket trading history for a specific wallet address
 * using the Data API's `/trades?maker=<address>` and `/trades?taker=<address>` endpoints.
 *
 * Used in two places:
 *   1. On-demand, when AnomalyDetector wants richer context for a known wallet
 *   2. By PositionTracker to seed the accumulation window for wallets that were
 *      already accumulating before the service started
 *
 * Results are cached in Redis to avoid hammering the API for the same wallet.
 */

import https from 'https';
import { RedisCache } from '../cache/RedisCache';
import { Logger } from '../utils/Logger';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WalletMarketPosition {
  marketId: string;
  marketName: string;
  side: 'YES' | 'NO';
  /** Total USDC spent buying this position */
  totalCostUsdc: number;
  /** Weighted average entry price */
  avgEntryPrice: number;
  /** Number of individual fills */
  fillCount: number;
  /** Timestamp of the first fill in this position (ms) */
  firstFillMs: number;
  /** Timestamp of the most recent fill (ms) */
  lastFillMs: number;
}

export interface WalletHistory {
  walletAddress: string;
  fetchedAt: number;
  positions: WalletMarketPosition[];
  /** Total USDC traded across all markets */
  totalVolumeUsdc: number;
  /** Number of distinct markets traded */
  distinctMarkets: number;
}

// ─── Internal API types ───────────────────────────────────────────────────────

interface DataAPITrade {
  proxyWallet?: string;
  maker?: string;
  taker?: string;
  side: 'BUY' | 'SELL';
  conditionId: string;
  slug?: string;
  title: string;
  size: number;
  price: number;
  timestamp: number;
  outcome?: string;
}

// ─── Class ────────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 300;  // 5 minutes — data is near-real-time
const REDIS_KEY_PREFIX = 'wallet_history:';
const MAX_PAGES = 5;            // cap at 5 × 200 = 1 000 trades to limit latency
const PAGE_SIZE = 200;

export class WalletHistoryFetcher {
  private readonly redisCache: RedisCache;
  private readonly logger: Logger;

  constructor(redisCache: RedisCache, logger: Logger) {
    this.redisCache = redisCache;
    this.logger = logger;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async fetchHistory(walletAddress: string): Promise<WalletHistory> {
    const cacheKey = `${REDIS_KEY_PREFIX}${walletAddress.toLowerCase()}`;

    // Redis cache hit
    try {
      const cached = await this.redisCache.get(cacheKey);
      if (cached) {
        this.logger.debug('WalletHistoryFetcher: cache hit', { walletAddress });
        return JSON.parse(cached) as WalletHistory;
      }
    } catch {
      // Cache miss or Redis unavailable — continue to API
    }

    this.logger.debug('WalletHistoryFetcher: fetching from Data API', { walletAddress });

    // Fetch both maker and taker sides in parallel
    const [makerTrades, takerTrades] = await Promise.all([
      this._fetchAllPages(walletAddress, 'maker'),
      this._fetchAllPages(walletAddress, 'taker'),
    ]);

    // Deduplicate by combining both — the same trade appears on both sides
    // in the API if the wallet both made and took in the same transaction (rare).
    // Use a simple Set of (conditionId+timestamp+size) as dedup key.
    const seen = new Set<string>();
    const allTrades: DataAPITrade[] = [];

    for (const t of [...makerTrades, ...takerTrades]) {
      const dedup = `${t.conditionId}:${t.timestamp}:${t.size}:${t.side}`;
      if (!seen.has(dedup)) {
        seen.add(dedup);
        allTrades.push(t);
      }
    }

    const history = this._aggregatePositions(walletAddress, allTrades);

    // Store in Redis
    try {
      await this.redisCache.set(cacheKey, JSON.stringify(history), CACHE_TTL_SECONDS);
    } catch {
      // Non-fatal
    }

    return history;
  }

  // ─── Aggregation ─────────────────────────────────────────────────────────

  private _aggregatePositions(walletAddress: string, trades: DataAPITrade[]): WalletHistory {
    // Group by market + side
    const groups = new Map<string, {
      marketId: string;
      marketName: string;
      side: 'YES' | 'NO';
      fills: Array<{ costUsdc: number; price: number; timestampMs: number }>;
    }>();

    for (const t of trades) {
      const side: 'YES' | 'NO' = t.side === 'BUY' ? 'YES' : 'NO';
      const costUsdc = t.side === 'BUY'
        ? t.size * t.price
        : t.size * (1 - t.price);

      const marketId = t.slug ?? t.conditionId;
      const key = `${marketId}:${side}`;

      let group = groups.get(key);
      if (!group) {
        group = {
          marketId,
          marketName: t.title,
          side,
          fills: [],
        };
        groups.set(key, group);
      }

      group.fills.push({
        costUsdc,
        price: t.price,
        timestampMs: t.timestamp * 1000,
      });
    }

    const positions: WalletMarketPosition[] = [];
    let totalVolumeUsdc = 0;

    for (const group of groups.values()) {
      const totalCostUsdc = group.fills.reduce((s, f) => s + f.costUsdc, 0);
      const avgEntryPrice = group.fills.length > 0
        ? group.fills.reduce((s, f) => s + f.price, 0) / group.fills.length
        : 0;
      const timestamps = group.fills.map(f => f.timestampMs);

      positions.push({
        marketId: group.marketId,
        marketName: group.marketName,
        side: group.side,
        totalCostUsdc,
        avgEntryPrice,
        fillCount: group.fills.length,
        firstFillMs: Math.min(...timestamps),
        lastFillMs: Math.max(...timestamps),
      });

      totalVolumeUsdc += totalCostUsdc;
    }

    // Sort by totalCostUsdc descending so biggest positions come first
    positions.sort((a, b) => b.totalCostUsdc - a.totalCostUsdc);

    return {
      walletAddress,
      fetchedAt: Date.now(),
      positions,
      totalVolumeUsdc,
      distinctMarkets: new Set(positions.map(p => p.marketId)).size,
    };
  }

  // ─── Pagination ───────────────────────────────────────────────────────────

  private async _fetchAllPages(
    walletAddress: string,
    role: 'maker' | 'taker',
  ): Promise<DataAPITrade[]> {
    const results: DataAPITrade[] = [];
    let offset = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this._fetchPage(walletAddress, role, offset);
      results.push(...batch);

      if (batch.length < PAGE_SIZE) break;  // last page
      offset += PAGE_SIZE;
    }

    return results;
  }

  private _fetchPage(
    walletAddress: string,
    role: 'maker' | 'taker',
    offset: number,
  ): Promise<DataAPITrade[]> {
    return new Promise((resolve, reject) => {
      const path = `/trades?${role}=${walletAddress}&limit=${PAGE_SIZE}&offset=${offset}`;

      const options: https.RequestOptions = {
        hostname: 'data-api.polymarket.com',
        path,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 10_000,
      };

      const req = https.request(options, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            reject(new Error(`WalletHistoryFetcher: JSON parse error: ${e}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('WalletHistoryFetcher: request timeout'));
      });
      req.end();
    });
  }
}
