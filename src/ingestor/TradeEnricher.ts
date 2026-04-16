/**
 * TradeEnricher - Enriches WebSocket trades with wallet addresses from Data API
 * 
 * WebSocket trades arrive in real-time but lack wallet addresses.
 * Data API trades have wallet addresses but arrive with a delay.
 * This class maintains a cache to match and enrich WebSocket trades.
 */

import { Logger } from '../utils/Logger';
import { RawTrade } from '../types/index';

interface CachedTrade {
  takerAddress: string;
  expiresAt: number;
}

export class TradeEnricher {
  private logger: Logger;
  private cache = new Map<string, CachedTrade>();
  private readonly CACHE_TTL_MS = 60_000; // 1 minute
  private readonly PRICE_TOLERANCE = 0.01; // 1% price difference allowed
  private readonly SIZE_TOLERANCE = 0.05; // 5% size difference allowed
  private readonly TIME_WINDOW_MS = 30_000; // 30 seconds time window
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
    this.startCleanup();
  }

  /**
   * Add a trade from Data API to the cache
   */
  addDataAPITrade(trade: RawTrade): void {
    if (!trade.taker_address) return;

    const key = this.generateKey(trade);
    this.cache.set(key, {
      takerAddress: trade.taker_address,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    this.logger.debug('TradeEnricher: cached Data API trade', {
      key: key.slice(0, 50),
      wallet: trade.taker_address.slice(0, 10) + '...',
    });
  }

  /**
   * Enrich a WebSocket trade with wallet address from cache
   */
  enrichWebSocketTrade(trade: RawTrade): RawTrade {
    // Already has wallet address
    if (trade.taker_address) return trade;

    // Try to find matching trade in cache
    const matches = this.findMatches(trade);
    
    if (matches.length === 0) {
      this.logger.debug('TradeEnricher: no match found for WebSocket trade', {
        marketId: trade.market_id.slice(0, 30),
        sizeUsd: trade.size_usd,
      });
      return trade;
    }

    // Use the first match (most recent)
    const match = matches[0];
    this.logger.info('TradeEnricher: enriched WebSocket trade with wallet', {
      marketId: trade.market_id.slice(0, 30),
      wallet: match.takerAddress.slice(0, 10) + '...',
    });

    return {
      ...trade,
      taker_address: match.takerAddress,
    };
  }

  /**
   * Find matching trades in cache using fuzzy matching
   */
  private findMatches(trade: RawTrade): CachedTrade[] {
    const now = Date.now();
    const matches: CachedTrade[] = [];

    for (const [key, cached] of this.cache.entries()) {
      // Skip expired entries
      if (cached.expiresAt < now) continue;

      // Parse the key
      const parts = key.split('|');
      if (parts.length !== 5) continue;

      const [marketId, side, priceStr, sizeStr, timestampStr] = parts;
      const cachedPrice = parseFloat(priceStr);
      const cachedSize = parseFloat(sizeStr);
      const cachedTimestamp = parseInt(timestampStr, 10);

      // Match market and side
      if (marketId !== trade.market_id || side !== trade.side) continue;

      // Match price within tolerance
      const priceDiff = Math.abs(cachedPrice - trade.price) / trade.price;
      if (priceDiff > this.PRICE_TOLERANCE) continue;

      // Match size within tolerance
      const sizeDiff = Math.abs(cachedSize - trade.size_usd) / trade.size_usd;
      if (sizeDiff > this.SIZE_TOLERANCE) continue;

      // Match timestamp within window
      const timeDiff = Math.abs(cachedTimestamp - trade.timestamp);
      if (timeDiff > this.TIME_WINDOW_MS) continue;

      matches.push(cached);
    }

    return matches;
  }

  /**
   * Generate a unique key for a trade
   */
  private generateKey(trade: RawTrade): string {
    return [
      trade.market_id,
      trade.side,
      trade.price.toFixed(4),
      trade.size_usd.toFixed(2),
      trade.timestamp,
    ].join('|');
  }

  /**
   * Periodically clean up expired cache entries
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let removed = 0;

      for (const [key, cached] of this.cache.entries()) {
        if (cached.expiresAt < now) {
          this.cache.delete(key);
          removed++;
        }
      }

      if (removed > 0) {
        this.logger.debug('TradeEnricher: cleaned up expired cache entries', {
          removed,
          remaining: this.cache.size,
        });
      }
    }, 30_000); // Clean up every 30 seconds
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }
}
