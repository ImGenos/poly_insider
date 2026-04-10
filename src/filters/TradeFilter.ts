import { RawTrade, FilteredTrade } from '../types/index';

const DEFAULT_MIN_TRADE_SIZE_USDC = 5000;

export class TradeFilter {
  private minTradeSizeUSDC: number;

  constructor(minTradeSizeUSDC: number = DEFAULT_MIN_TRADE_SIZE_USDC) {
    this.minTradeSizeUSDC = minTradeSizeUSDC;
  }

  /**
   * Filter a raw trade against the minimum size threshold.
   * Returns a FilteredTrade (camelCase fields) if size_usd >= threshold, null otherwise.
   * Does NOT mutate the input trade.
   */
  filter(trade: RawTrade): FilteredTrade | null {
    if (trade.size_usd < this.minTradeSizeUSDC) {
      return null;
    }

    // Always use the taker address: the taker is the aggressive order placer who
    // crossed the spread and initiated the trade, making them the more meaningful
    // signal for anomaly detection regardless of side.
    const walletAddress = trade.taker_address;

    return {
      marketId: trade.market_id,
      marketName: trade.market_name,
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
