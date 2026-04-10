export declare class AnalyzerService {
    private readonly config;
    private readonly logger;
    private readonly redisCache;
    private readonly timeSeriesDB;
    private readonly tradeFilter;
    private readonly blockchainAnalyzer;
    private readonly anomalyDetector;
    private readonly clusterDetector;
    private readonly alertFormatter;
    private readonly telegramNotifier;
    private running;
    private depthCheckTimer;
    /** Sliding window of booleans: true = malformed, false = ok (last 100 messages) */
    private malformedWindow;
    /** Consecutive Alchemy failure counter (resets on success) */
    private alchemyConsecutiveFails;
    private alchemyDegradedAlertSent;
    /** Timestamp of last successful TimescaleDB write */
    private lastSuccessfulDbWrite;
    private timescaleDbAlertSent;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    private startDepthMonitor;
    private consumeLoop;
    private processMessage;
    private ackMessage;
    private runAnomalyDetector;
    private runClusterDetector;
    private appendPricePoint;
    private trackMalformed;
}
export default function main(): Promise<void>;
//# sourceMappingURL=index.d.ts.map