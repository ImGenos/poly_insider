import { FilteredTrade, MarketVolatility, PricePoint } from '../types/index';
import { Logger } from '../utils/Logger';
export declare class TimeSeriesDB {
    private pool;
    private readonly connectionString;
    private readonly logger;
    constructor(connectionString: string, logger: Logger);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    private initSchema;
    appendPricePoint(marketId: string, price: number, timestamp: Date): Promise<void>;
    getPriceHistory(marketId: string, since: Date): Promise<PricePoint[]>;
    getMarketVolatility(marketId: string, _windowMinutes: number): Promise<MarketVolatility>;
    recordClusterTrade(trade: FilteredTrade): Promise<void>;
    getClusterWallets(marketId: string, side: string, since: Date): Promise<string[]>;
    getClusterTotalSize(marketId: string, side: string, since: Date): Promise<number>;
}
//# sourceMappingURL=TimeSeriesDB.d.ts.map