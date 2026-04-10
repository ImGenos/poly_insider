"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeFilter = void 0;
const DEFAULT_MIN_TRADE_SIZE_USDC = 5000;
class TradeFilter {
    constructor(minTradeSizeUSDC = DEFAULT_MIN_TRADE_SIZE_USDC) {
        this.minTradeSizeUSDC = minTradeSizeUSDC;
    }
    /**
     * Filter a raw trade against the minimum size threshold.
     * Returns a FilteredTrade (camelCase fields) if size_usd >= threshold, null otherwise.
     * Does NOT mutate the input trade.
     */
    filter(trade) {
        if (trade.size_usd < this.minTradeSizeUSDC) {
            return null;
        }
        // side=YES means buy (taker is the buyer), side=NO means sell (maker is the seller)
        const walletAddress = trade.side === 'YES' ? trade.taker_address : trade.maker_address;
        return {
            marketId: trade.market_id,
            marketName: trade.market_name,
            side: trade.side,
            price: trade.price,
            sizeUSDC: trade.size_usd,
            timestamp: new Date(trade.timestamp),
            walletAddress,
            orderBookLiquidity: trade.order_book_depth.bid_liquidity + trade.order_book_depth.ask_liquidity,
            // marketCategory is intentionally left undefined — caller can set it
        };
    }
    setMinimumSize(sizeUSDC) {
        this.minTradeSizeUSDC = sizeUSDC;
    }
    getMinimumSize() {
        return this.minTradeSizeUSDC;
    }
}
exports.TradeFilter = TradeFilter;
//# sourceMappingURL=TradeFilter.js.map