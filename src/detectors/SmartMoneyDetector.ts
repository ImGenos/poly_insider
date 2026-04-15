import { FilteredTrade, Severity } from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { Logger } from '../utils/Logger';

// Keywords for excluding football and tennis markets (high-frequency noise, no insider signal)
const EXCLUDED_SPORTS_KEYWORDS = [
  // Football / Soccer
  'football',
  'soccer',
  'champions league',
  'premier league',
  'la liga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'uefa',
  'fifa',
  'world cup',
  'euro',
  'copa',
  // Tennis
  'tennis',
  'atp',
  'wta',
  'grand slam',
  'wimbledon',
  'roland garros',
  'us open',
  'australian open',
  'french open',
  'davis cup',
];

// Minimum transfers required before we trust the score.
// A wallet with only 1-2 USDC transfers has no meaningful pattern.
const MIN_TRANSFERS_FOR_SCORING = 5;

export interface SmartMoneyConfig {
  minTradeSizeUSDC: number;
  confidenceThreshold: number;
  walletProfileTTL: number;
}

export interface BettorConfidenceIndex {
  walletAddress: string;
  score: number; // 0–100
  metrics: {
    recentVolume: number;
    volumeScore: number;
    betSizeRatio: number;
    betSizeScore: number;
    /** How regularly the wallet trades (low CV = consistent = higher score). */
    activityConsistency: number;
    activityConsistencyScore: number;
    transferCount: number;
  };
  calculatedAt: Date;
}

export interface SmartMoneyAlert {
  marketId: string;
  marketName: string;
  side: 'YES' | 'NO';
  amount: number;
  price: number;
  walletAddress: string;
  confidenceIndex: BettorConfidenceIndex;
  severity: Severity;
  detectedAt: Date;
}

export class SmartMoneyDetector {
  private readonly config: SmartMoneyConfig;
  private readonly timeSeriesDB: TimeSeriesDB;
  private readonly redisCache: RedisCache;
  private readonly alchemyApiKey: string;
  private readonly logger: Logger;

  constructor(
    config: SmartMoneyConfig,
    timeSeriesDB: TimeSeriesDB,
    redisCache: RedisCache,
    _blockchainAnalyzer: BlockchainAnalyzer,
    logger: Logger,
    alchemyApiKey: string,
  ) {
    this.config = config;
    this.timeSeriesDB = timeSeriesDB;
    this.redisCache = redisCache;
    this.alchemyApiKey = alchemyApiKey;
    this.logger = logger;
  }

  // ─── Market filter ────────────────────────────────────────────────────────

  /** Returns true when the market should be EXCLUDED (football/tennis noise). */
  isExcludedMarket(trade: FilteredTrade): boolean {
    const searchText = `${trade.marketName} ${trade.marketCategory ?? ''}`.toLowerCase();
    return EXCLUDED_SPORTS_KEYWORDS.some(kw => searchText.includes(kw));
  }

  // ─── Confidence index ─────────────────────────────────────────────────────

  async calculateBettorConfidenceIndex(
    walletAddress: string,
    currentTradeSize: number,
  ): Promise<BettorConfidenceIndex | null> {
    const cached = await this.getCachedConfidenceIndex(walletAddress);
    if (cached) {
      this.logger.debug('SmartMoneyDetector: using cached confidence index', { walletAddress });
      return cached;
    }

    try {
      const metrics = await this.fetchWalletMetrics(walletAddress, currentTradeSize);
      if (!metrics) return null;

      const volumeScore            = this.scoreVolume(metrics.recentVolume);
      const betSizeScore           = this.scoreBetSize(metrics.betSizeRatio);
      const activityConsistencyScore = this.scoreActivityConsistency(metrics.activityConsistency);

      // Weights: volume 35 % | bet-size ratio 35 % | activity consistency 30 %
      // PnL is NOT included: it cannot be derived from raw USDC transfer history
      // without tracking resolved market outcomes separately.
      const finalScore =
        volumeScore            * 0.35 +
        betSizeScore           * 0.35 +
        activityConsistencyScore * 0.30;

      const confidenceIndex: BettorConfidenceIndex = {
        walletAddress,
        score: Math.round(finalScore),
        metrics: {
          recentVolume:              metrics.recentVolume,
          volumeScore,
          betSizeRatio:              metrics.betSizeRatio,
          betSizeScore,
          activityConsistency:       metrics.activityConsistency,
          activityConsistencyScore,
          transferCount:             metrics.transferCount,
        },
        calculatedAt: new Date(),
      };

      await this.cacheConfidenceIndex(confidenceIndex);
      return confidenceIndex;
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to calculate confidence index', {
        walletAddress,
        error: String(err),
      });
      return null;
    }
  }

  // ─── Wallet metrics from Alchemy ──────────────────────────────────────────

  private async fetchWalletMetrics(
    walletAddress: string,
    currentTradeSize: number,
  ): Promise<{
    recentVolume: number;
    betSizeRatio: number;
    /** Coefficient of Variation of trade sizes (stddev / mean). Lower = more consistent. */
    activityConsistency: number;
    transferCount: number;
  } | null> {
    const transfers = await this.getPolymarketUsdcTransfers(walletAddress);

    if (transfers.length < MIN_TRANSFERS_FOR_SCORING) {
      this.logger.debug('SmartMoneyDetector: insufficient transfer history', {
        walletAddress,
        transferCount: transfers.length,
        required: MIN_TRANSFERS_FOR_SCORING,
      });
      return null;
    }

    // Volume over the last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentVolume = transfers
      .filter(tx => tx.timestamp > thirtyDaysAgo)
      .reduce((sum, tx) => sum + tx.value, 0);

    // Bet-size ratio: how many times larger is this trade vs. the wallet average?
    const values = transfers.map(tx => tx.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const betSizeRatio = mean > 0 ? currentTradeSize / mean : 1;

    // Activity consistency: Coefficient of Variation (CV = stddev / mean).
    // A low CV means the wallet trades in steady, similar-sized lots — a hallmark
    // of a disciplined, experienced bettor rather than a one-off participant.
    // CV is bounded to [0, 3] before inversion so a single outlier doesn't collapse
    // the score entirely.
    const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 3; // treat zero-mean as maximally inconsistent
    // Invert: low CV → high consistency score
    const activityConsistency = Math.max(0, 1 - Math.min(cv, 3) / 3);

    return {
      recentVolume,
      betSizeRatio,
      activityConsistency,
      transferCount: transfers.length,
    };
  }

  // ─── Alchemy: fetch USDC transfers to Polymarket CTF Exchange ────────────

  private async getPolymarketUsdcTransfers(
    walletAddress: string,
  ): Promise<Array<{ timestamp: number; value: number }>> {
    const POLYMARKET_CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
    const url = `https://polygon-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`;

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromAddress: walletAddress,
        toAddress: POLYMARKET_CTF_EXCHANGE,
        category: ['erc20'],
        maxCount: 100,
        order: 'desc',
        withMetadata: true,
      }],
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error(`Alchemy HTTP ${response.status}`);

      const data = await response.json() as AlchemyAssetTransferResponse;
      if (data.error) throw new Error(`Alchemy RPC: ${data.error.message}`);

      return (data.result?.transfers ?? [])
        .filter(tx => tx.asset?.toUpperCase() === 'USDC' && tx.value != null)
        .map(tx => ({
          timestamp: tx.metadata?.blockTimestamp
            ? new Date(tx.metadata.blockTimestamp).getTime()
            : Date.now(),
          value: tx.value!,
        }));
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: Alchemy transfer fetch failed', {
        walletAddress,
        error: String(err),
      });
      return [];
    }
  }

  // ─── Scoring functions ────────────────────────────────────────────────────

  /**
   * Volume over the last 30 days.
   * < $500 → 0   |   > $10 k → 100   |   linear in between.
   * $10k/month is a realistic bar for an active Polymarket trader.
   */
  private scoreVolume(recentVolume: number): number {
    if (recentVolume <= 500)    return 0;
    if (recentVolume >= 10_000) return 100;
    return ((recentVolume - 500) / 9_500) * 100;
  }

  /**
   * Bet-size ratio (current / wallet average).
   * < 0.5 × → 0   |   > 3 × → 100   |   linear in between.
   * 3x the wallet's average is already a strong conviction signal on Polymarket.
   */
  private scoreBetSize(ratio: number): number {
    if (ratio <= 0.5) return 0;
    if (ratio >= 3)   return 100;
    return ((ratio - 0.5) / 2.5) * 100;
  }

  /**
   * Activity consistency = 1 − min(CV, 3) / 3  (already in [0, 1]).
   * 0 (chaotic sizes) → 0   |   1 (perfectly uniform) → 100.
   */
  private scoreActivityConsistency(consistency: number): number {
    return Math.max(0, Math.min(consistency, 1)) * 100;
  }

  // ─── Redis cache helpers ──────────────────────────────────────────────────

  private async getCachedConfidenceIndex(
    walletAddress: string,
  ): Promise<BettorConfidenceIndex | null> {
    try {
      const raw = await this.redisCache.get(`smart_money:${walletAddress}`);
      return raw ? (JSON.parse(raw) as BettorConfidenceIndex) : null;
    } catch {
      return null;
    }
  }

  private async cacheConfidenceIndex(index: BettorConfidenceIndex): Promise<void> {
    try {
      await this.redisCache.set(
        `smart_money:${index.walletAddress}`,
        JSON.stringify(index),
        this.config.walletProfileTTL,
      );
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to cache confidence index', {
        walletAddress: index.walletAddress,
        error: String(err),
      });
    }
  }

  // ─── Main detection entry point ───────────────────────────────────────────

  async detect(trade: FilteredTrade): Promise<SmartMoneyAlert | null> {
    if (this.isExcludedMarket(trade))                            return null;
    if (trade.sizeUSDC < this.config.minTradeSizeUSDC)   return null;
    if (!trade.walletAddress) {
      this.logger.debug('SmartMoneyDetector: no wallet address', { marketId: trade.marketId });
      return null;
    }

    const confidenceIndex = await this.calculateBettorConfidenceIndex(
      trade.walletAddress,
      trade.sizeUSDC,
    );
    if (!confidenceIndex)                                           return null;
    if (confidenceIndex.score < this.config.confidenceThreshold)   return null;

    const severity: Severity =
      confidenceIndex.score >= 90 ? 'CRITICAL' :
      confidenceIndex.score >= 85 ? 'HIGH'     :
      'MEDIUM';

    await this.recordSmartMoneyTrade(trade, confidenceIndex);

    return {
      marketId:        trade.marketId,
      marketName:      trade.marketName,
      side:            trade.side,
      amount:          trade.sizeUSDC,
      price:           trade.price,
      walletAddress:   trade.walletAddress,
      confidenceIndex,
      severity,
      detectedAt:      new Date(),
    };
  }

  // ─── TimescaleDB persistence ──────────────────────────────────────────────

  private async recordSmartMoneyTrade(
    trade: FilteredTrade,
    ci: BettorConfidenceIndex,
  ): Promise<void> {
    try {
      await this.timeSeriesDB.recordSmartMoneyTrade({
        timestamp:       trade.timestamp,
        marketId:        trade.marketId,
        marketName:      trade.marketName,
        side:            trade.side,
        walletAddress:   trade.walletAddress!,
        sizeUSDC:        trade.sizeUSDC,
        price:           trade.price,
        confidenceScore: ci.score,
        // PnL is not computable from raw transfer data; store 0 as a neutral placeholder.
        // A future upgrade could derive this by cross-referencing resolved market outcomes.
        pnl:             0,
        recentVolume:    ci.metrics.recentVolume,
        betSizeRatio:    ci.metrics.betSizeRatio,
        // Re-purpose the win_rate column to store activity consistency (same range: 0–1).
        winRate:         ci.metrics.activityConsistency,
      });
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to record trade', {
        marketId: trade.marketId,
        error: String(err),
      });
    }
  }
}

// ─── Alchemy response types ───────────────────────────────────────────────────

interface AlchemyAssetTransferResponse {
  jsonrpc: string;
  id: number;
  result?: {
    transfers: Array<{
      value?: number;
      asset?: string;
      metadata?: { blockTimestamp?: string };
    }>;
  };
  error?: { code: number; message: string };
}