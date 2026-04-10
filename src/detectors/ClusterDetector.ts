import { FilteredTrade, ClusterAnomaly, FundingAnalysis, DetectionThresholds } from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { Logger } from '../utils/Logger';

export class ClusterDetector {
  private readonly thresholds: DetectionThresholds;
  private readonly timeSeriesDB: TimeSeriesDB;
  private readonly redisCache: RedisCache;
  private readonly blockchainAnalyzer: BlockchainAnalyzer;
  private readonly logger: Logger;
  private readonly clusterDedupTtlSeconds: number;

  constructor(
    thresholds: DetectionThresholds,
    timeSeriesDB: TimeSeriesDB,
    redisCache: RedisCache,
    blockchainAnalyzer: BlockchainAnalyzer,
    logger: Logger,
    clusterDedupTtlSeconds = 600,
  ) {
    this.thresholds = thresholds;
    this.timeSeriesDB = timeSeriesDB;
    this.redisCache = redisCache;
    this.blockchainAnalyzer = blockchainAnalyzer;
    this.logger = logger;
    this.clusterDedupTtlSeconds = clusterDedupTtlSeconds;
  }

  // ─── recordTrade ──────────────────────────────────────────────────────────

  /**
   * Persist every filtered trade to the cluster_trades hypertable.
   * Requirements 6.1
   */
  async recordTrade(trade: FilteredTrade): Promise<void> {
    await this.timeSeriesDB.recordClusterTrade(trade);
  }

  // ─── detectCluster ────────────────────────────────────────────────────────

  /**
   * Record the trade, then check whether a coordinated cluster has formed.
   * Requirements 6.1–6.9
   */
  async detectCluster(trade: FilteredTrade): Promise<ClusterAnomaly | null> {
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
    let fundingAnalysis: FundingAnalysis | null = null;
    let fundingFailed = false;

    try {
      fundingAnalysis = await this.blockchainAnalyzer.analyzeClusterFunding(distinctWallets);
    } catch (err) {
      fundingFailed = true;
      this.logger.warn('ClusterDetector: analyzeClusterFunding failed, degrading to HIGH severity', {
        marketId: trade.marketId,
        side: trade.side,
        error: String(err),
      });
    }

    // Step 7: determine severity (Req 6.5, 6.6, Error Scenario 11)
    let severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
    let attachedFundingAnalysis: FundingAnalysis | undefined;

    if (fundingFailed) {
      // Non-blocking degradation: use HIGH when funding analysis unavailable
      severity = 'HIGH';
    } else if (fundingAnalysis !== null && fundingAnalysis.hasCommonNonExchangeFunder) {
      // Req 6.5: CRITICAL when common non-exchange funder found
      severity = 'CRITICAL';
      attachedFundingAnalysis = fundingAnalysis;
    } else if (distinctWallets.length >= 5) {
      // Req 6.6: HIGH for >= 5 wallets
      severity = 'HIGH';
    } else {
      // Req 6.6: MEDIUM for >= 3 wallets (already checked >= clusterMinWallets above)
      severity = 'MEDIUM';
    }

    // Step 8: get total size for the window
    const totalSizeUSDC = await this.timeSeriesDB.getClusterTotalSize(
      trade.marketId,
      trade.side,
      since,
    );

    // Step 9: build ClusterAnomaly
    const anomaly: ClusterAnomaly = {
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

    // Step 10: record dedup key so callers don't need to (Req 6.7)
    await this.redisCache.recordClusterAlert(trade.marketId, trade.side, this.clusterDedupTtlSeconds);

    return anomaly;
  }
}
