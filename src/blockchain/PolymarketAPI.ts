import { Logger } from '../utils/Logger';
import { sleep } from '../utils/helpers';

/**
 * Client for Polymarket Gamma REST API
 * Provides market data including price history, order book, and market stats
 */
export class PolymarketAPI {
  private readonly baseUrl = 'https://gamma-api.polymarket.com';
  private readonly logger: Logger;
  
  // Rate limiting: conservative approach for public API
  private lastCallTime = 0;
  private readonly minIntervalMs = 100;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastCallTime = Date.now();
  }

  /**
   * Get market data including current prices and order book
   * @param conditionId - The market condition ID
   */
  async getMarket(conditionId: string): Promise<PolymarketMarketData | null> {
    await this.throttle();

    try {
      const url = `${this.baseUrl}/markets/${conditionId}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        this.logger.warn('PolymarketAPI: failed to fetch market data', {
          conditionId,
          status: response.status,
        });
        return null;
      }

      const data = await response.json() as PolymarketMarketResponse;
      
      return {
        conditionId: data.condition_id,
        bestBid: parseFloat(data.best_bid || '0'),
        bestAsk: parseFloat(data.best_ask || '0'),
        lastPrice: parseFloat(data.last_price || '0'),
        volume24h: parseFloat(data.volume_24h || '0'),
        liquidity: parseFloat(data.liquidity || '0'),
      };
    } catch (err) {
      this.logger.error('PolymarketAPI: error fetching market data', {
        conditionId,
        error: String(err),
      });
      return null;
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolymarketMarketData {
  conditionId: string;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  volume24h: number;
  liquidity: number;
}

interface PolymarketMarketResponse {
  condition_id: string;
  best_bid?: string;
  best_ask?: string;
  last_price?: string;
  volume_24h?: string;
  liquidity?: string;
}
