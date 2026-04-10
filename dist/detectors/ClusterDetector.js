"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClusterDetector = void 0;
class ClusterDetector {
    constructor(thresholds, timeSeriesDB, redisCache, blockchainAnalyzer, logger) {
        this.thresholds = thresholds;
        this.timeSeriesDB = timeSeriesDB;
        this.redisCache = redisCache;
        this.blockchainAnalyzer = blockchainAnalyzer;
        this.logger = logger;
    }
    // ─── recordTrade ──────────────────────────────────────────────────────────
    /**
     * Persist every filtered trade to the cluster_trades hypertable.
     * Requirements 6.1
     */
    async recordTrade(trade) {
        await this.timeSeriesDB.recordClusterTrade(trade);
    }
    // ─── detectCluster ────────────────────────────────────────────────────────
    /**
     * Record the trade, then check whether a coordinated cluster has formed.
     * Requirements 6.1–6.9
     */
    async detectCluster(trade) {
        const { clusterWindowMinutes, clusterMinWallets } = this.thresholds;
        // Step 1: persist trade (Req 6.1) — do NOT mutate input (Req 6.9)
        await this.recordTrade(trade);
        // Step 2: query distinct wallets within the window (Req 6.2)
        const since = new Date(Date.now() - clusterWindowMinutes * 60 * 1000);
        const rawWallets = await this.timeSeriesDB.getClusterWallets(trade.marketId, trade.side, since);
        // Step 3: deduplicate wallet list (Req 6.8)
        const distinctWallets = [...new Set(rawWallets)];
        // Step 4: return null if below threshold (Req 6.3)
        if (distinctWallets.length < clusterMinWallets) {
            return null;
        }
        // Step 5: deduplication — skip if alert already sent for this market/side (Req 6.7)
        const alreadySent = await this.redisCache.hasClusterAlertBeenSent(trade.marketId, trade.side);
        if (alreadySent) {
            return null;
        }
        // Step 6: funding analysis (Req 6.4) — degrade gracefully on failure (Error Scenario 11)
        let fundingAnalysis = null;
        let fundingFailed = false;
        try {
            fundingAnalysis = await this.blockchainAnalyzer.analyzeClusterFunding(distinctWallets);
        }
        catch (err) {
            fundingFailed = true;
            this.logger.warn('ClusterDetector: analyzeClusterFunding failed, degrading to HIGH severity', {
                marketId: trade.marketId,
                side: trade.side,
                error: String(err),
            });
        }
        // Step 7: determine severity (Req 6.5, 6.6, Error Scenario 11)
        let severity;
        let attachedFundingAnalysis;
        if (fundingFailed) {
            // Non-blocking degradation: use HIGH when funding analysis unavailable
            severity = 'HIGH';
        }
        else if (fundingAnalysis !== null && fundingAnalysis.hasCommonNonExchangeFunder) {
            // Req 6.5: CRITICAL when common non-exchange funder found
            severity = 'CRITICAL';
            attachedFundingAnalysis = fundingAnalysis;
        }
        else if (distinctWallets.length >= 5) {
            // Req 6.6: HIGH for >= 5 wallets
            severity = 'HIGH';
        }
        else {
            // Req 6.6: MEDIUM for >= 3 wallets (already checked >= clusterMinWallets above)
            severity = 'MEDIUM';
        }
        // Step 8: get total size for the window
        const totalSizeUSDC = await this.timeSeriesDB.getClusterTotalSize(trade.marketId, trade.side, since);
        // Step 9: build ClusterAnomaly
        const anomaly = {
            type: 'COORDINATED_MOVE',
            marketId: trade.marketId,
            marketName: trade.marketName,
            side: trade.side,
            wallets: distinctWallets,
            totalSizeUSDC,
            windowMinutes: clusterWindowMinutes,
            detectedAt: new Date(),
            severity,
            ...(attachedFundingAnalysis !== undefined ? { fundingAnalysis: attachedFundingAnalysis } : {}),
        };
        return anomaly;
    }
}
exports.ClusterDetector = ClusterDetector;
//# sourceMappingURL=ClusterDetector.js.map