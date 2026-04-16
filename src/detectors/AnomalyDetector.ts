import {
  FilteredTrade,
  Anomaly,
  AnomalyType,
  Severity,
  MarketVolatility,
  PricePoint,
  DetectionThresholds,
} from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { PolymarketAPI } from '../blockchain/PolymarketAPI';
import { Logger } from '../utils/Logger';
import { calculateZScore } from '../utils/helpers';

const VALID_ANOMALY_TYPES: AnomalyType[] = [
  'RAPID_ODDS_SHIFT',
  'WHALE_ACTIVITY',
  'INSIDER_TRADING',
  'COORDINATED_MOVE',
];

const VALID_SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export class AnomalyDetector {
  private readonly thresholds: DetectionThresholds;
  private readonly timeSeriesDB: TimeSeriesDB;
  private readonly redisCache: RedisCache;
  private readonly blockchainAnalyzer: BlockchainAnalyzer;
  private readonly polymarketAPI: PolymarketAPI | null;
  private readonly logger: Logger;

  constructor(
    thresholds: DetectionThresholds,
    timeSeriesDB: TimeSeriesDB,
    redisCache: RedisCache,
    blockchainAnalyzer: BlockchainAnalyzer,
    polymarketAPIOrLogger: PolymarketAPI | Logger | null,
    logger?: Logger,
  ) {
    this.thresholds = thresholds;
    this.timeSeriesDB = timeSeriesDB;
    this.redisCache = redisCache;
    this.blockchainAnalyzer = blockchainAnalyzer;
    // Support both 5-arg (no polymarketAPI) and 6-arg (with polymarketAPI) signatures
    if (logger !== undefined) {
      this.polymarketAPI = polymarketAPIOrLogger as PolymarketAPI | null;
      this.logger = logger;
    } else {
      this.polymarketAPI = null;
      this.logger = polymarketAPIOrLogger as Logger;
    }
  }

  // ─── Task 11.1: detectRapidOddsShift (Hybrid: Market-Level) ──────────────────

  /**
   * Detect rapid odds shifts using market-level data from Polymarket Gamma API
   * Falls back to local price history if API unavailable
   */
  async detectRapidOddsShift(
    trade: FilteredTrade,
    priceHistory: PricePoint[],
    volatility: MarketVolatility | null,
    staticThresholdPercent: number,
    zScoreThreshold: number,
  ): Promise<Anomaly | null> {
    // Try to get real-time market data from Polymarket Gamma API first
    const marketData = this.polymarketAPI ? await this.polymarketAPI.getMarket(trade.marketId) : null;
    
    // API signal: check deviation from live market mid-price
    let apiDetected: Anomaly | null = null;
    if (marketData && marketData.lastPrice > 0) {
      const midPrice = (marketData.bestBid + marketData.bestAsk) / 2;
      // Guard: skip API branch if midPrice is zero or NaN
      if (midPrice > 0 && !isNaN(midPrice)) {
        const priceDeviation = Math.abs(trade.price - midPrice);
        const deviationPercent = (priceDeviation / midPrice) * 100;

        if (deviationPercent >= staticThresholdPercent) {
          const severity: Severity = deviationPercent > 25 ? 'HIGH' : 'MEDIUM';
          const confidence = Math.min(deviationPercent / (staticThresholdPercent * 2), 1.0);

          apiDetected = {
            type: 'RAPID_ODDS_SHIFT',
            severity,
            confidence,
            details: {
              description: `Rapid odds shift detected via Polymarket API: ${deviationPercent.toFixed(2)}% deviation from market mid-price`,
              metrics: {
                tradePrice: trade.price,
                marketMidPrice: midPrice,
                bestBid: marketData.bestBid,
                bestAsk: marketData.bestAsk,
                deviationPercent,
                volume24h: marketData.volume24h,
                liquidity: marketData.liquidity,
              },
            },
            detectedAt: new Date(),
          };
        }
      }
      // Do NOT return null here — always run the Z-score check as a complementary signal.
    }

    // Z-score signal: always evaluated when local volatility data is available,
    // regardless of whether the API succeeded. This makes detection truly additive.
    const zScoreMinSamples = this.thresholds.zScoreMinSamples;

    if (
      volatility !== null &&
      volatility.sampleCount >= zScoreMinSamples &&
      volatility.stddevPrice > 0 &&
      priceHistory.length >= 1
    ) {
      const lastKnownPrice = priceHistory[priceHistory.length - 1].price;
      const priceChange = Math.abs(trade.price - lastKnownPrice);
      // Z-score the delta: how many standard deviations is this move?
      const zScore = calculateZScore(priceChange, 0, volatility.stddevPrice);

      if (zScore >= zScoreThreshold) {
        const severity: Severity = zScore > zScoreThreshold * 2 ? 'HIGH' : 'MEDIUM';
        const confidence = 1 / (1 + Math.exp(-(zScore - zScoreThreshold)));

        // If both signals fire, take the higher-confidence result
        const zScoreDetected: Anomaly = {
          type: 'RAPID_ODDS_SHIFT',
          severity,
          confidence,
          details: {
            description: apiDetected
              ? `Rapid odds shift confirmed by both API and Z-score: ${zScore.toFixed(2)}σ`
              : `Rapid odds shift detected via Z-score: ${zScore.toFixed(2)}σ`,
            metrics: {
              zScore,
              priceChange,
              avgPrice: volatility.avgPrice,
              stddevPrice: volatility.stddevPrice,
              currentPrice: trade.price,
              sampleCount: volatility.sampleCount,
              ...(apiDetected ? { apiConfidence: apiDetected.confidence } : {}),
            },
          },
          detectedAt: new Date(),
        };

        // Return whichever signal has higher confidence
        if (!apiDetected || zScoreDetected.confidence >= apiDetected.confidence) {
          return zScoreDetected;
        }
        return apiDetected;
      }
    }

    // Z-score didn't fire — return API result if it did, or fall through to static check
    if (apiDetected) return apiDetected;

    if (priceHistory.length === 0) {
      return null;
    }

    const firstPrice = priceHistory[0].price;
    if (firstPrice === 0) {
      return null;
    }

    const staticChange = Math.abs(trade.price - firstPrice) / firstPrice * 100;

    if (staticChange < staticThresholdPercent) {
      return null;
    }

    const severity: Severity = staticChange > 25 ? 'HIGH' : 'MEDIUM';
    const confidence = Math.min(staticChange / (staticThresholdPercent * 2), 1.0);

    return {
      type: 'RAPID_ODDS_SHIFT',
      severity,
      confidence,
      details: {
        description: `Rapid odds shift detected via static threshold (fallback): ${staticChange.toFixed(2)}%`,
        metrics: {
          priceChangePercent: staticChange,
          currentPrice: trade.price,
          firstPrice,
          staticThresholdPercent,
        },
      },
      detectedAt: new Date(),
    };
  }

  // ─── Task 11.2: detectWhaleActivity (Hybrid: Wallet-Level Behavioral) ────────

  /**
   * Detect whale activity using wallet-level behavioral Z-score
   * Compares current trade size to wallet's historical trading pattern
   */
  async detectWhaleActivity(
    trade: FilteredTrade,
    volatility: MarketVolatility | null,
    staticThresholdPercent: number,
    zScoreThreshold: number,
  ): Promise<Anomaly | null> {
    // If wallet address is available, use behavioral Z-score approach
    if (trade.walletAddress) {
      try {
        const walletHistory = await this.blockchainAnalyzer.getWalletTradeHistory(
          trade.walletAddress,
          100,
        );

        // walletHistory.fetchFailed is no longer used — if we reach here, fetch succeeded
        if (walletHistory.tradeCount >= 5 && walletHistory.stddevTradeSize > 0 && walletHistory.avgTradeSize > 0) {
          // We have a real behavioral baseline for this wallet
          const behavioralZScore = calculateZScore(
            trade.sizeUSDC,
            walletHistory.avgTradeSize,
            walletHistory.stddevTradeSize,
          );

          if (behavioralZScore >= zScoreThreshold) {
            const severity: Severity = behavioralZScore > zScoreThreshold * 2 ? 'HIGH' : 'MEDIUM';
            const confidence = 1 / (1 + Math.exp(-(behavioralZScore - zScoreThreshold)));

            return {
              type: 'WHALE_ACTIVITY',
              severity,
              confidence,
              details: {
                description: `Whale activity via behavioral Z-score: ${behavioralZScore.toFixed(2)}σ — ` +
                  `wallet trading ${(trade.sizeUSDC / walletHistory.avgTradeSize).toFixed(1)}x their average`,
                metrics: {
                  behavioralZScore,
                  currentTradeSize: trade.sizeUSDC,
                  walletAvgTradeSize: walletHistory.avgTradeSize,
                  walletStddevTradeSize: walletHistory.stddevTradeSize,
                  walletTradeCount: walletHistory.tradeCount,
                  walletAddress: trade.walletAddress,
                },
              },
              detectedAt: new Date(),
            };
          }

          // Behavioral baseline exists and trade is within normal range for this wallet.
          // Return null — do NOT fall through to market Z-score, which would generate
          // a false positive for a whale who is simply making a normal-sized trade.
          return null;
        }
        // Insufficient wallet history (tradeCount < 5 or stddev === 0)
        // Fall through to market-level fallbacks (static threshold / Z-score)
        // so large trades are still flagged even without behavioral baseline.
      } catch (err) {
        // Alchemy call failed — log and fall through to market-level static threshold
        this.logger.warn('AnomalyDetector: getWalletTradeHistory failed, using market fallback', {
          walletAddress: trade.walletAddress,
          error: String(err),
        });
        // Fall through to market-level Z-score / static threshold below
      }
    }

    // Fallback to market-level Z-score or static thresholds
    const hasLiquidityData = trade.orderBookLiquidity > 0;
    const zScoreMinSamples = this.thresholds.zScoreMinSamples;

    if (
      volatility !== null &&
      volatility.sampleCount >= zScoreMinSamples &&
      volatility.stddevTradeSize > 0
    ) {
      const zScore = calculateZScore(trade.sizeUSDC, volatility.avgTradeSize, volatility.stddevTradeSize);

      if (zScore < zScoreThreshold) {
        return null;
      }

      const severity: Severity = zScore > zScoreThreshold * 2 ? 'HIGH' : 'MEDIUM';
      const confidence = 1 / (1 + Math.exp(-(zScore - zScoreThreshold)));

      return {
        type: 'WHALE_ACTIVITY',
        severity,
        confidence,
        details: {
          description: `Whale activity detected via market Z-score (fallback): ${zScore.toFixed(2)}σ`,
          metrics: {
            zScore,
            sizeUSDC: trade.sizeUSDC,
            avgTradeSize: volatility.avgTradeSize,
            stddevTradeSize: volatility.stddevTradeSize,
            sampleCount: volatility.sampleCount,
          },
        },
        detectedAt: new Date(),
      };
    }

    if (!hasLiquidityData) {
      const whaleMinSize = this.thresholds.insiderMinTradeSize;
      if (trade.sizeUSDC < whaleMinSize) {
        return null;
      }
      const severity: Severity = trade.sizeUSDC > whaleMinSize * 5 ? 'HIGH' : 'MEDIUM';
      const confidence = Math.min(trade.sizeUSDC / (whaleMinSize * 10), 1.0);
      return {
        type: 'WHALE_ACTIVITY',
        severity,
        confidence,
        details: {
          description: `Whale activity detected via size threshold (fallback): ${trade.sizeUSDC.toFixed(0)} USDC`,
          metrics: {
            sizeUSDC: trade.sizeUSDC,
            whaleMinSize,
          },
        },
        detectedAt: new Date(),
      };
    }

    const liquidityPercent = (trade.sizeUSDC / trade.orderBookLiquidity) * 100;

    if (liquidityPercent < staticThresholdPercent) {
      return null;
    }

    let severity: Severity;
    if (liquidityPercent > 50) {
      severity = 'HIGH';
    } else if (liquidityPercent > 20) {
      severity = 'MEDIUM';
    } else {
      severity = 'LOW';
    }

    const confidence = Math.min(liquidityPercent / 100, 1.0);

    return {
      type: 'WHALE_ACTIVITY',
      severity,
      confidence,
      details: {
        description: `Whale activity detected via static threshold (fallback): ${liquidityPercent.toFixed(2)}% of liquidity`,
        metrics: {
          liquidityConsumedPercent: liquidityPercent,
          sizeUSDC: trade.sizeUSDC,
          orderBookLiquidity: trade.orderBookLiquidity,
          staticThresholdPercent,
        },
      },
      detectedAt: new Date(),
    };
  }

  // ─── Task 11.3: detectInsiderTrading ─────────────────────────────────────

  async detectInsiderTrading(trade: FilteredTrade): Promise<Anomaly | null> {
    const {
      insiderWalletAgeHours,
      insiderMinTradeSize,
    } = this.thresholds;

    // Req 5.1: analyzeWalletProfile checks Redis cache before any Alchemy call
    const walletProfile = await this.blockchainAnalyzer.analyzeWalletProfile(
      trade.walletAddress || '',
      this.redisCache,
    );

    const ageHours = walletProfile.ageHours;
    const transactionCount = walletProfile.transactionCount;

    // New wallet + large trade — fires on ANY market (no category gate)
    const isNewWallet = ageHours !== null && ageHours < insiderWalletAgeHours;
    const isLargeTrade = trade.sizeUSDC >= insiderMinTradeSize;

    if (!isNewWallet || !isLargeTrade) {
      return null;
    }

    // Req 5.7: confidence calculation
    const ageScore = ageHours !== null
      ? Math.max(0, Math.min(1, 1 - (ageHours / insiderWalletAgeHours)))
      : 0;

    const sizeScore = Math.min(trade.sizeUSDC / (insiderMinTradeSize * 10), 1.0);

    const activityScore = Math.max(0, 1 - (transactionCount / 100));

    const confidence = ageScore * 0.4 + sizeScore * 0.3 + activityScore * 0.3;

    // Req 5.8: severity based on confidence
    let severity: Severity;
    if (confidence > 0.8) {
      severity = 'HIGH';
    } else if (confidence > 0.5) {
      severity = 'MEDIUM';
    } else {
      severity = 'LOW';
    }

    return {
      type: 'INSIDER_TRADING',
      severity,
      confidence,
      details: {
        description: `Insider trading pattern detected: new wallet (${ageHours?.toFixed(1)}h old) making large trade`,
        metrics: {
          ageHours,
          ageScore,
          sizeUSDC: trade.sizeUSDC,
          sizeScore,
          transactionCount,
          activityScore,
          marketCategory: trade.marketCategory,
          walletAddress: trade.walletAddress,
        },
      },
      detectedAt: new Date(),
    };
  }

  // ─── Task 11.4: analyze orchestrator ─────────────────────────────────────

  async analyze(trade: FilteredTrade): Promise<Anomaly[]> {
    const {
      rapidOddsShiftPercent,
      rapidOddsShiftWindowMinutes,
      whaleActivityPercent,
      zScoreThreshold,
    } = this.thresholds;

    // Fetch volatility and price history — fall back gracefully if TimescaleDB unavailable (Req 16.2)
    let volatility: MarketVolatility | null = null;
    let priceHistory: PricePoint[] = [];

    try {
      volatility = await this.timeSeriesDB.getMarketVolatility(trade.marketId);
    } catch (err) {
      this.logger.warn('AnomalyDetector: getMarketVolatility failed, using static thresholds', {
        marketId: trade.marketId,
        error: String(err),
      });
    }

    try {
      const since = new Date(Date.now() - rapidOddsShiftWindowMinutes * 60 * 1000);
      priceHistory = await this.timeSeriesDB.getPriceHistory(trade.marketId, since);
    } catch (err) {
      this.logger.warn('AnomalyDetector: getPriceHistory failed, rapid odds shift using empty history', {
        marketId: trade.marketId,
        error: String(err),
      });
    }

    const results: Anomaly[] = [];

    // Run all three detectors (now async)
    const rapidOddsAnomaly = await this.detectRapidOddsShift(
      trade,
      priceHistory,
      volatility,
      rapidOddsShiftPercent,
      zScoreThreshold,
    );

    let whaleAnomaly: Anomaly | null = null;
    try {
      whaleAnomaly = await this.detectWhaleActivity(
        trade,
        volatility,
        whaleActivityPercent,
        zScoreThreshold,
      );
    } catch (err) {
      this.logger.warn('AnomalyDetector: detectWhaleActivity failed, skipping whale detection', {
        marketId: trade.marketId,
        error: String(err),
      });
    }

    let insiderAnomaly: Anomaly | null = null;
    try {
      insiderAnomaly = await this.detectInsiderTrading(trade);
    } catch (err) {
      this.logger.warn('AnomalyDetector: detectInsiderTrading failed', {
        marketId: trade.marketId,
        error: String(err),
      });
    }

    for (const anomaly of [rapidOddsAnomaly, whaleAnomaly, insiderAnomaly]) {
      if (anomaly === null) continue;

      // Req 15.3: validate confidence in [0, 1]
      if (anomaly.confidence < 0 || anomaly.confidence > 1) {
        this.logger.warn('AnomalyDetector: anomaly confidence out of range, skipping', {
          type: anomaly.type,
          confidence: anomaly.confidence,
        });
        continue;
      }

      // Req 15.4: validate anomaly type
      if (!VALID_ANOMALY_TYPES.includes(anomaly.type)) {
        this.logger.warn('AnomalyDetector: invalid anomaly type, skipping', { type: anomaly.type });
        continue;
      }

      // Req 15.5: validate severity
      if (!VALID_SEVERITIES.includes(anomaly.severity)) {
        this.logger.warn('AnomalyDetector: invalid anomaly severity, skipping', { severity: anomaly.severity });
        continue;
      }

      results.push(anomaly);
    }

    return results;
  }
}
