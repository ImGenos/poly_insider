import { FilteredTrade, Severity } from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { Logger } from '../utils/Logger';

// BUG FIX: Per spec, SmartMoney fires on markets NOT in this exclusion list.
// The old code used FOOTBALL_KEYWORDS as an *inclusion* filter (only football),
// which contradicted the spec ("marchés non exclu — pas football/tennis").
// These are the markets to EXCLUDE from SmartMoney detection.
const EXCLUDED_MARKET_KEYWORDS = [
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
  'euro cup',
  'copa',
  'tennis',
  'wimbledon',
  'roland garros',
  'us open',
  'australian open',
  'atp',
  'wta',
  'nba',
  'nfl',
  'mlb',
  'nhl',
  'formula 1',
];

// Polymarket CTF Exchange contract on Polygon
const POLYMARKET_CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase();

// Minimum number of historical Polymarket transfers required to compute a score
const MIN_TRADE_HISTORY = 5;

export interface SmartMoneyConfig {
  minTradeSizeUSDC: number;
  confidenceThreshold: number; // Score minimum pour déclencher une alerte (ex: 80)
  walletProfileTTL: number;    // TTL en secondes pour le cache des profils (ex: 86400 = 24h)
}

export interface BettorConfidenceIndex {
  walletAddress: string;
  score: number; // 0-100
  metrics: {
    // BUG FIX: Replaced PnL/winRate metrics (hardcoded/estimated) with the three
    // metrics specified: recent volume (35%), bet-size ratio (35%), regularity (30%).
    recentVolume: number;
    volumeScore: number;
    betSizeRatio: number;
    betSizeScore: number;
    regularityCV: number;   // Coefficient of variation (lower = more regular)
    regularityScore: number;
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
  private readonly logger: Logger;

  constructor(
    config: SmartMoneyConfig,
    timeSeriesDB: TimeSeriesDB,
    redisCache: RedisCache,
    _blockchainAnalyzer: BlockchainAnalyzer,
    logger: Logger,
  ) {
    this.config = config;
    this.timeSeriesDB = timeSeriesDB;
    this.redisCache = redisCache;
    this.logger = logger;
  }

  // ─── Market Filter ────────────────────────────────────────────────────────

  /**
   * BUG FIX: The old method `isFootballMarket()` was used as an *inclusion* gate,
   * meaning SmartMoney only fired for football markets. The spec says SmartMoney
   * should fire on ALL markets EXCEPT those in the exclusion list (football, tennis,
   * major sports leagues). This method now returns true when the market should be
   * EXCLUDED (i.e. it IS a sports/tennis market), so the caller can skip it.
   */
  isExcludedMarket(trade: FilteredTrade): boolean {
    const searchText = `${trade.marketName} ${trade.marketCategory ?? ''}`.toLowerCase();
    return EXCLUDED_MARKET_KEYWORDS.some(keyword => searchText.includes(keyword));
  }

  // ─── Confidence Index Calculation ────────────────────────────────────────

  async calculateBettorConfidenceIndex(
    walletAddress: string,
    currentTradeSize: number,
  ): Promise<BettorConfidenceIndex | null> {
    // Check Redis cache first
    const cached = await this.getCachedConfidenceIndex(walletAddress);
    if (cached) {
      this.logger.debug('SmartMoneyDetector: using cached confidence index', { walletAddress });
      return cached;
    }

    try {
      const metrics = await this.fetchWalletMetrics(walletAddress, currentTradeSize);
      if (!metrics) {
        return null;
      }

      // BUG FIX: Weights corrected to match spec:
      //   volume 35%, bet-size ratio 35%, regularity 30%
      // Old code used: PnL 40%, volume 20%, bet size 25%, win rate 15% (all wrong).
      const volumeScore      = this.calculateVolumeScore(metrics.recentVolume);
      const betSizeScore     = this.calculateBetSizeScore(metrics.betSizeRatio);
      const regularityScore  = this.calculateRegularityScore(metrics.regularityCV);

      const finalScore =
        volumeScore     * 0.35 +
        betSizeScore    * 0.35 +
        regularityScore * 0.30;

      const confidenceIndex: BettorConfidenceIndex = {
        walletAddress,
        score: Math.round(finalScore),
        metrics: {
          recentVolume: metrics.recentVolume,
          volumeScore,
          betSizeRatio: metrics.betSizeRatio,
          betSizeScore,
          regularityCV: metrics.regularityCV,
          regularityScore,
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

  // ─── Wallet Metrics ───────────────────────────────────────────────────────

  private async fetchWalletMetrics(
    walletAddress: string,
    currentTradeSize: number,
  ): Promise<{
    recentVolume: number;
    betSizeRatio: number;
    regularityCV: number;
  } | null> {
    const history = await this.getPolymarketHistory(walletAddress);

    // BUG FIX: spec requires ≥ 5 transfers to compute a meaningful score
    if (!history || history.length < MIN_TRADE_HISTORY) {
      return null;
    }

    // Volume over the last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentTrades  = history.filter(tx => tx.timestamp > thirtyDaysAgo);
    const recentVolume  = recentTrades.reduce((sum, tx) => sum + tx.value, 0);

    // Bet-size ratio: current trade vs historical average
    const tradeSizes  = history.map(tx => tx.value);
    const avgSize     = tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length;
    const betSizeRatio = avgSize > 0 ? currentTradeSize / avgSize : 1;

    // BUG FIX: Regularity via coefficient of variation (CV = stddev / mean).
    // Lower CV → more regular trader → higher score. Old code had no regularity metric.
    const regularityCV = this.calculateCV(tradeSizes);

    return { recentVolume, betSizeRatio, regularityCV };
  }

  private async getPolymarketHistory(walletAddress: string): Promise<PolymarketTransaction[]> {
    try {
      const alchemyApiKey = process.env.ALCHEMY_API_KEY ?? '';
      const url = `https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;

      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromAddress: walletAddress,
          toAddress: POLYMARKET_CTF_EXCHANGE,
          category: ['external', 'erc20'],
          maxCount: 100,
          order: 'desc',
        }],
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Alchemy HTTP error: ${response.status}`);
      }

      const data = await response.json() as AlchemyAssetTransferResponse;

      if (data.error) {
        throw new Error(`Alchemy RPC error: ${data.error.message}`);
      }

      const transfers = data.result?.transfers ?? [];

      return transfers.map(tx => ({
        hash: tx.hash ?? '',
        timestamp: tx.metadata?.blockTimestamp
          ? new Date(tx.metadata.blockTimestamp).getTime()
          : Date.now(),
        value: tx.value ? parseFloat(tx.value) : 0,
        asset: tx.asset ?? 'USDC',
      }));
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to fetch Polymarket history', {
        walletAddress,
        error: String(err),
      });
      return [];
    }
  }

  // ─── Score Calculators ────────────────────────────────────────────────────

  /**
   * BUG FIX: Volume thresholds corrected to match spec ($500 → 0, $10k → 100).
   * Old code used $1k → 0, $100k → 100 (wrong scale).
   */
  private calculateVolumeScore(recentVolume: number): number {
    if (recentVolume <= 500)    return 0;
    if (recentVolume >= 10_000) return 100;
    return ((recentVolume - 500) / 9_500) * 100;
  }

  /**
   * BUG FIX: Bet-size ratio thresholds corrected to match spec (< 0.5× → 0, > 3× → 100).
   * Old code used 0.5× → 0, 10× → 100 (wrong upper bound).
   */
  private calculateBetSizeScore(betSizeRatio: number): number {
    if (betSizeRatio <= 0.5) return 0;
    if (betSizeRatio >= 3)   return 100;
    return ((betSizeRatio - 0.5) / 2.5) * 100;
  }

  /**
   * BUG FIX: New metric replacing the hardcoded win-rate.
   * Regularity score = 1 - CV (coefficient of variation).
   * A regular trader (low CV) gets a high score; an erratic one (high CV) gets low.
   * CV is clamped to [0, 1] so scores stay in [0, 100].
   */
  private calculateRegularityScore(cv: number): number {
    const clampedCV = Math.min(Math.max(cv, 0), 1);
    return (1 - clampedCV) * 100;
  }

  /**
   * Coefficient of variation (stddev / mean). Returns 1 (maximum irregularity)
   * when there are fewer than 2 values or the mean is zero.
   */
  private calculateCV(values: number[]): number {
    if (values.length < 2) return 1;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean === 0) return 1;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  // ─── Redis Cache ───────────────────────────────────────────────────────────

  private async getCachedConfidenceIndex(
    walletAddress: string,
  ): Promise<BettorConfidenceIndex | null> {
    try {
      const key    = `smart_money:${walletAddress}`;
      const cached = await this.redisCache.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as BettorConfidenceIndex;
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to get cached confidence index', {
        walletAddress,
        error: String(err),
      });
      return null;
    }
  }

  private async cacheConfidenceIndex(index: BettorConfidenceIndex): Promise<void> {
    try {
      const key = `smart_money:${index.walletAddress}`;
      await this.redisCache.set(key, JSON.stringify(index), this.config.walletProfileTTL);
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to cache confidence index', {
        walletAddress: index.walletAddress,
        error: String(err),
      });
    }
  }

  // ─── Main Detection ───────────────────────────────────────────────────────

  async detect(trade: FilteredTrade): Promise<SmartMoneyAlert | null> {
    // BUG FIX: Gate logic inverted. Old code: `if (!isFootballMarket) return null`
    // (only football). New code: `if (isExcludedMarket) return null` (exclude sports).
    if (this.isExcludedMarket(trade)) {
      return null;
    }

    if (trade.sizeUSDC < this.config.minTradeSizeUSDC) {
      return null;
    }

    if (!trade.walletAddress) {
      this.logger.debug('SmartMoneyDetector: no wallet address available', {
        marketId: trade.marketId,
      });
      return null;
    }

    const confidenceIndex = await this.calculateBettorConfidenceIndex(
      trade.walletAddress,
      trade.sizeUSDC,
    );

    if (!confidenceIndex) {
      return null;
    }

    if (confidenceIndex.score < this.config.confidenceThreshold) {
      return null;
    }

    let severity: Severity;
    if (confidenceIndex.score >= 90) {
      severity = 'CRITICAL';
    } else if (confidenceIndex.score >= 85) {
      severity = 'HIGH';
    } else {
      severity = 'MEDIUM';
    }

    await this.recordSmartMoneyTrade(trade, confidenceIndex);

    return {
      marketId: trade.marketId,
      marketName: trade.marketName,
      side: trade.side,
      amount: trade.sizeUSDC,
      price: trade.price,
      walletAddress: trade.walletAddress,
      confidenceIndex,
      severity,
      detectedAt: new Date(),
    };
  }

  // ─── TimescaleDB Storage ──────────────────────────────────────────────────

  private async recordSmartMoneyTrade(
    trade: FilteredTrade,
    confidenceIndex: BettorConfidenceIndex,
  ): Promise<void> {
    try {
      await this.timeSeriesDB.recordSmartMoneyTrade({
        timestamp: trade.timestamp,
        marketId: trade.marketId,
        marketName: trade.marketName,
        side: trade.side,
        walletAddress: trade.walletAddress!,
        sizeUSDC: trade.sizeUSDC,
        price: trade.price,
        confidenceScore: confidenceIndex.score,
        // Map new metric fields onto the DB columns (pnl/winRate are legacy columns
        // kept for schema compatibility; store regularity score in pnl slot,
        // CV in win_rate slot so historical data stays queryable).
        pnl: confidenceIndex.metrics.regularityScore,
        recentVolume: confidenceIndex.metrics.recentVolume,
        betSizeRatio: confidenceIndex.metrics.betSizeRatio,
        winRate: confidenceIndex.metrics.regularityCV,
      });
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to record smart money trade', {
        marketId: trade.marketId,
        error: String(err),
      });
    }
  }
}

// ─── Internal Types ────────────────────────────────────────────────────────

interface PolymarketTransaction {
  hash: string;
  timestamp: number;
  value: number;
  asset: string;
}

interface AlchemyAssetTransferResponse {
  jsonrpc: string;
  id: number;
  result?: {
    transfers: Array<{
      hash?: string;
      value?: string;
      asset?: string;
      metadata?: {
        blockTimestamp?: string;
      };
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}