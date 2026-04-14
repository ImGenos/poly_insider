/**
 * DataAPIPoller - Polls Polymarket Data API for recent trades
 * 
 * The WebSocket market channel doesn't reliably stream all trades.
 * This poller fetches recent trades from the Data API as a backup/primary source.
 */

import https from 'https';
import { Logger } from '../utils/Logger';
import { RawTrade } from '../types/index';

export interface DataAPITrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
}

export class DataAPIPoller {
  private logger: Logger;
  private pollInterval: number;
  private lastSeenTimestamp: number;
  private timer: NodeJS.Timeout | null = null;
  private tradeCallback: ((trade: RawTrade) => void) | null = null;

  constructor(logger: Logger, pollIntervalMs: number = 10000) {
    this.logger = logger;
    this.pollInterval = pollIntervalMs;
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
  }

  onTrade(callback: (trade: RawTrade) => void): void {
    this.tradeCallback = callback;
  }

  start(): void {
    this.logger.info('DataAPIPoller starting', { pollIntervalMs: this.pollInterval });
    this._poll(); // Initial poll
    this.timer = setInterval(() => this._poll(), this.pollInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('DataAPIPoller stopped');
  }

  private async _poll(): Promise<void> {
    try {
      const trades = await this._fetchRecentTrades();
      
      if (trades.length === 0) {
        return;
      }

      // Process trades in chronological order (oldest first)
      const newTrades = trades
        .filter(t => t.timestamp > this.lastSeenTimestamp)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (newTrades.length > 0) {
        this.logger.debug('DataAPIPoller: new trades', { count: newTrades.length });
        
        for (const trade of newTrades) {
          const normalized = this._normalizeDataAPITrade(trade);
          if (normalized) {
            this.tradeCallback?.(normalized);
          }
        }

        // Update last seen timestamp
        this.lastSeenTimestamp = newTrades[newTrades.length - 1].timestamp;
      }
    } catch (err) {
      this.logger.error('DataAPIPoller: poll failed', err);
    }
  }

  private _fetchRecentTrades(): Promise<DataAPITrade[]> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'data-api.polymarket.com',
        path: '/trades?limit=100&takerOnly=true',
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const trades = JSON.parse(data);
            resolve(Array.isArray(trades) ? trades : []);
          } catch (e) {
            reject(new Error(`Failed to parse Data API response: ${e}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Data API request timeout'));
      });

      req.end();
    });
  }

  private _normalizeDataAPITrade(trade: DataAPITrade): RawTrade | null {
    try {
      return {
        market_id: trade.conditionId,
        market_name: trade.title,
        side: trade.side === 'BUY' ? 'YES' : 'NO',
        price: trade.price,
        size: trade.size,
        size_usd: trade.size * trade.price,
        timestamp: trade.timestamp * 1000, // Convert to milliseconds
        maker_address: undefined, // Not available in Data API
        taker_address: trade.proxyWallet,
        order_book_depth: { bid_liquidity: 0, ask_liquidity: 0 },
        market_category: undefined // Will be enriched by market metadata
      };
    } catch (err) {
      this.logger.warn('Failed to normalize Data API trade', { trade, error: err });
      return null;
    }
  }
}
