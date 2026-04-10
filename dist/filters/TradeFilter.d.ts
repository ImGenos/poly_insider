import { RawTrade, FilteredTrade } from '../types/index';
export declare class TradeFilter {
    private minTradeSizeUSDC;
    constructor(minTradeSizeUSDC?: number);
    /**
     * Filter a raw trade against the minimum size threshold.
     * Returns a FilteredTrade (camelCase fields) if size_usd >= threshold, null otherwise.
     * Does NOT mutate the input trade.
     */
    filter(trade: RawTrade): FilteredTrade | null;
    setMinimumSize(sizeUSDC: number): void;
    getMinimumSize(): number;
}
//# sourceMappingURL=TradeFilter.d.ts.map