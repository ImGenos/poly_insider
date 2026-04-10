import { FilteredTrade, Anomaly, MarketVolatility, PricePoint, DetectionThresholds } from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { Logger } from '../utils/Logger';
export declare class AnomalyDetector {
    private readonly thresholds;
    private readonly timeSeriesDB;
    private readonly redisCache;
    private readonly blockchainAnalyzer;
    private readonly logger;
    constructor(thresholds: DetectionThresholds, timeSeriesDB: TimeSeriesDB, redisCache: RedisCache, blockchainAnalyzer: BlockchainAnalyzer, logger: Logger);
    detectRapidOddsShift(trade: FilteredTrade, priceHistory: PricePoint[], volatility: MarketVolatility | null, staticThresholdPercent: number, zScoreThreshold: number): Anomaly | null;
    detectWhaleActivity(trade: FilteredTrade, volatility: MarketVolatility | null, staticThresholdPercent: number, zScoreThreshold: number): Anomaly | null;
    detectInsiderTrading(trade: FilteredTrade): Promise<Anomaly | null>;
    analyze(trade: FilteredTrade): Promise<Anomaly[]>;
}
//# sourceMappingURL=AnomalyDetector.d.ts.map