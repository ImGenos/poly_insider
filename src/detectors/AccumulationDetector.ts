/**
 * AccumulationDetector
 *
 * Receives synthetic RawTrades emitted by PositionTracker and converts them
 * into structured Anomaly objects that fit the existing pipeline.
 *
 * It also fetches the full wallet history (via WalletHistoryFetcher) to enrich
 * the alert with context: how many markets has this wallet traded, what is its
 * total all-time volume, and how long did this accumulation take.
 *
 * This is intentionally a thin layer — the heavy lifting (Telegram formatting,
 * deduplication, TimescaleDB recording) is done by the existing AnalyzerService.
 */

import { FilteredTrade, Anomaly, Severity } from '../types/index';
import { WalletHistoryFetcher, WalletHistory } from '../ingestor/WalletHistoryFetcher';
import { RedisCache } from '../cache/RedisCache';
import { Logger } from '../utils/Logger';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AccumulationAnomaly extends Anomaly {
  type: 'WHALE_ACTIVITY';
  accumulationContext: {
    totalSizeUsd: number;
    windowHours: number;
    walletTotalVolumeUsdc: number;
    walletDistinctMarkets: number;
    isFirstTimeOnThisMarket: boolean;
  };
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class AccumulationDetector {
  private readonly walletHistoryFetcher: WalletHistoryFetcher;
  private readonly redisCache: RedisCache;
  private readonly logger: Logger;

  /** Accumulation window in ms — must match PositionTracker config. */
  private readonly accumulationWindowMs: number;

  constructor(
    walletHistoryFetcher: WalletHistoryFetcher,
    redisCache: RedisCache,
    logger: Logger,
    accumulationWindowMs = 4 * 60 * 60 * 1000,
  ) {
    this.walletHistoryFetcher = walletHistoryFetcher;
    this.redisCache = redisCache;
    this.logger = logger;
    this.accumulationWindowMs = accumulationWindowMs;
  }

  // ─── Detection ───────────────────────────────────────────────────────────

  async detect(trade: FilteredTrade): Promise<AccumulationAnomaly | null> {
    // Only process trades marked as accumulation events by PositionTracker
    if (trade.marketCategory !== 'accumulation') return null;
    if (!trade.walletAddress) return null;

    // Fetch enriched wallet context (cached 5 min)
    let walletHistory: WalletHistory | null = null;
    try {
      walletHistory = await this.walletHistoryFetcher.fetchHistory(trade.walletAddress);
    } catch (err) {
      this.logger.warn('AccumulationDetector: wallet history fetch failed, using basic context', {
        wallet: trade.walletAddress,
        error: String(err),
      });
    }

    const windowHours = this.accumulationWindowMs / 3_600_000;

    // Determine if this wallet has ever traded this market before
    const isFirstTimeOnThisMarket = walletHistory
      ? !walletHistory.positions.some(p => p.marketId === trade.marketId)
      : false;

    // Build confidence: higher when wallet is new to the market (more suspicious)
    // and when total accumulated amount is large relative to wallet's typical activity.
    let confidence = this._calculateConfidence(trade, walletHistory, isFirstTimeOnThisMarket);

    const severity: Severity = confidence >= 0.8 ? 'HIGH'
      : confidence >= 0.6 ? 'MEDIUM'
      : 'LOW';

    const walletTotalVolumeUsdc = walletHistory?.totalVolumeUsdc ?? 0;
    const walletDistinctMarkets = walletHistory?.distinctMarkets ?? 0;

    const anomaly: AccumulationAnomaly = {
      type: 'WHALE_ACTIVITY',
      severity,
      confidence,
      details: {
        description:
          `Gradual position accumulation: ${trade.sizeUSDC.toFixed(0)} USDC ` +
          `accumulated over ${windowHours.toFixed(1)}h via limit orders ` +
          `(not visible in real-time WebSocket stream)`,
        metrics: {
          totalAccumulatedUsdc: trade.sizeUSDC,
          accumulationWindowHours: windowHours,
          walletAddress: trade.walletAddress,
          walletTotalVolumeUsdc,
          walletDistinctMarkets,
          isFirstTimeOnThisMarket,
          detectionMethod: 'position_polling',
        },
      },
      detectedAt: new Date(),
      accumulationContext: {
        totalSizeUsd: trade.sizeUSDC,
        windowHours,
        walletTotalVolumeUsdc,
        walletDistinctMarkets,
        isFirstTimeOnThisMarket,
      },
    };

    this.logger.info('AccumulationDetector: anomaly detected', {
      wallet: trade.walletAddress.slice(0, 10) + '...',
      marketId: trade.marketId,
      sizeUsd: trade.sizeUSDC.toFixed(0),
      severity,
      confidence: confidence.toFixed(2),
    });

    return anomaly;
  }

  // ─── Confidence calculation ────────────────────────────────────────────────

  private _calculateConfidence(
    trade: FilteredTrade,
    walletHistory: WalletHistory | null,
    isFirstTimeOnThisMarket: boolean,
  ): number {
    // Base confidence from raw size
    // $20k threshold → 0.5 base, scales up to 1.0 at $100k+
    const sizeScore = Math.min((trade.sizeUSDC - 20_000) / 80_000 + 0.5, 1.0);

    // First-time bonus: new wallet on market is more suspicious
    const noveltyBonus = isFirstTimeOnThisMarket ? 0.2 : 0.0;

    // Concentration bonus: if this single position is a large fraction of
    // the wallet's total historical volume, it indicates unusual conviction.
    let concentrationBonus = 0;
    if (walletHistory && walletHistory.totalVolumeUsdc > 0) {
      const fraction = trade.sizeUSDC / walletHistory.totalVolumeUsdc;
      // fraction > 0.3 → this single bet is >30% of all-time volume
      concentrationBonus = Math.min(fraction * 0.5, 0.3);
    }

    return Math.min(sizeScore + noveltyBonus + concentrationBonus, 1.0);
  }
}
