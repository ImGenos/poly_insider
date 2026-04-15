import { RawTrade, FilteredTrade } from '../types/index';

const DEFAULT_MIN_TRADE_SIZE_USDC = 5000;

/**
 * Matches short-duration market names like:
 *   "Will X happen in the next 5 minutes?"
 *   "5-min", "5 min", "5minute", "10 minutes", "15-minute", etc.
 * Covers 1–59 minute windows to catch all intraday noise markets.
 */
const SHORT_DURATION_MARKET_REGEX = /\b([1-9]|[1-5]\d)\s*-?\s*min(ute)?s?\b/i;

export class TradeFilter {
  private minTradeSizeUSDC: number;

  constructor(minTradeSizeUSDC: number = DEFAULT_MIN_TRADE_SIZE_USDC) {
    this.minTradeSizeUSDC = minTradeSizeUSDC;
  }

  /**
   * Filter a raw trade against the minimum size threshold and market duration.
   * Returns a FilteredTrade (camelCase fields) if size_usd >= threshold and the
   * market is not a short-duration (sub-hour) market, null otherwise.
   * Does NOT mutate the input trade.
   */
  filter(trade: RawTrade): FilteredTrade | null {
    if (trade.size_usd < this.minTradeSizeUSDC) {
      return null;
    }

    if (SHORT_DURATION_MARKET_REGEX.test(trade.market_name)) {
      return null;
    }

    // Always use the taker address: the taker is the aggressive order placer who
    // crossed the spread and initiated the trade, making them the more meaningful
    // signal for anomaly detection regardless of side.
    const walletAddress = trade.taker_address;

    return {
      marketId: trade.market_id,
      marketName: trade.market_name,
      outcome: trade.outcome,
      side: trade.side,
      price: trade.price,
      sizeUSDC: trade.size_usd,
      timestamp: new Date(trade.timestamp),
      walletAddress,
      orderBookLiquidity: trade.order_book_depth.bid_liquidity + trade.order_book_depth.ask_liquidity,
      marketCategory: trade.market_category,
    };
  }

  setMinimumSize(sizeUSDC: number): void {
    this.minTradeSizeUSDC = sizeUSDC;
  }

  getMinimumSize(): number {
    return this.minTradeSizeUSDC;
  }
}
