import { RawTrade, FilteredTrade } from '../types/index';

const DEFAULT_MIN_TRADE_SIZE_USDC = 5000;

/**
 * Matches Polymarket's "N Minute" crypto price markets exclusively:
 *   Title:       "[Asset] N Minute"          e.g. "Bitcoin 5 Minute"
 *   Description: "Will X go up or down in the next N minutes?"
 *
 * These are high-frequency noise markets with no insider-trading signal.
 * The pattern is intentionally narrow to avoid false positives on legitimate
 * sports or event markets that may mention durations incidentally.
 */
const SHORT_DURATION_MARKET_REGEX =
  /\b\d+\s+minutes?\b|\bwill\s+\w+\s+go\s+up\s+or\s+down\s+in\s+the\s+next\s+\d+\s+minutes?\b/i;

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
