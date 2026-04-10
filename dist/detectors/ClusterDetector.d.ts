import { FilteredTrade, ClusterAnomaly, DetectionThresholds } from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { Logger } from '../utils/Logger';
export declare class ClusterDetector {
    private readonly thresholds;
    private readonly timeSeriesDB;
    private readonly redisCache;
    private readonly blockchainAnalyzer;
    private readonly logger;
    constructor(thresholds: DetectionThresholds, timeSeriesDB: TimeSeriesDB, redisCache: RedisCache, blockchainAnalyzer: BlockchainAnalyzer, logger: Logger);
    /**
     * Persist every filtered trade to the cluster_trades hypertable.
     * Requirements 6.1
     */
    recordTrade(trade: FilteredTrade): Promise<void>;
    /**
     * Record the trade, then check whether a coordinated cluster has formed.
     * Requirements 6.1–6.9
     */
    detectCluster(trade: FilteredTrade): Promise<ClusterAnomaly | null>;
}
//# sourceMappingURL=ClusterDetector.d.ts.map