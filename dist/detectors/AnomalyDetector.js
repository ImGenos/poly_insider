"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnomalyDetector = void 0;
const helpers_1 = require("../utils/helpers");
const VALID_ANOMALY_TYPES = [
    'RAPID_ODDS_SHIFT',
    'WHALE_ACTIVITY',
    'INSIDER_TRADING',
    'COORDINATED_MOVE',
];
const VALID_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
class AnomalyDetector {
    constructor(thresholds, timeSeriesDB, redisCache, blockchainAnalyzer, logger) {
        this.thresholds = thresholds;
        this.timeSeriesDB = timeSeriesDB;
        this.redisCache = redisCache;
        this.blockchainAnalyzer = blockchainAnalyzer;
        this.logger = logger;
    }
    // ─── Task 11.1: detectRapidOddsShift ─────────────────────────────────────
    detectRapidOddsShift(trade, priceHistory, volatility, staticThresholdPercent, zScoreThreshold) {
        // Req 3.6: return null if price history is empty
        if (priceHistory.length === 0) {
            return null;
        }
        const zScoreMinSamples = this.thresholds.zScoreMinSamples;
        // Req 3.1: use Z-score when sufficient samples and stddev > 0
        if (volatility !== null &&
            volatility.sampleCount >= zScoreMinSamples &&
            volatility.stddevPriceChange > 0) {
            const priceChange = Math.abs(trade.price - volatility.avgPriceChange);
            const zScore = (0, helpers_1.calculateZScore)(trade.price, volatility.avgPriceChange, volatility.stddevPriceChange);
            if (zScore < zScoreThreshold) {
                return null;
            }
            // Req 3.3: HIGH if Z-score > 2× threshold, MEDIUM otherwise
            const severity = zScore > zScoreThreshold * 2 ? 'HIGH' : 'MEDIUM';
            // Req 3.5: confidence formula
            const confidence = Math.min(zScore / (zScoreThreshold * 2), 1.0);
            return {
                type: 'RAPID_ODDS_SHIFT',
                severity,
                confidence,
                details: {
                    description: `Rapid odds shift detected via Z-score: ${zScore.toFixed(2)}σ`,
                    metrics: {
                        zScore,
                        priceChange,
                        avgPriceChange: volatility.avgPriceChange,
                        stddevPriceChange: volatility.stddevPriceChange,
                        currentPrice: trade.price,
                        sampleCount: volatility.sampleCount,
                    },
                },
                detectedAt: new Date(),
            };
        }
        // Req 3.2: static threshold fallback
        const firstPrice = priceHistory[0].price;
        if (firstPrice === 0) {
            return null;
        }
        const staticChange = Math.abs(trade.price - firstPrice) / firstPrice * 100;
        if (staticChange < staticThresholdPercent) {
            return null;
        }
        // Req 3.4: HIGH if static change > 25%, MEDIUM otherwise
        const severity = staticChange > 25 ? 'HIGH' : 'MEDIUM';
        // Proportional confidence for static path
        const confidence = Math.min(staticChange / (staticThresholdPercent * 2), 1.0);
        return {
            type: 'RAPID_ODDS_SHIFT',
            severity,
            confidence,
            details: {
                description: `Rapid odds shift detected via static threshold: ${staticChange.toFixed(2)}%`,
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
    // ─── Task 11.2: detectWhaleActivity ──────────────────────────────────────
    detectWhaleActivity(trade, volatility, staticThresholdPercent, zScoreThreshold) {
        // Req 4.3: return null if orderBookLiquidity is zero or unavailable
        if (!trade.orderBookLiquidity || trade.orderBookLiquidity === 0) {
            return null;
        }
        const zScoreMinSamples = this.thresholds.zScoreMinSamples;
        // Req 4.1: use Z-score when sufficient samples and stddev > 0
        if (volatility !== null &&
            volatility.sampleCount >= zScoreMinSamples &&
            volatility.stddevTradeSize > 0) {
            const zScore = (0, helpers_1.calculateZScore)(trade.sizeUSDC, volatility.avgTradeSize, volatility.stddevTradeSize);
            if (zScore < zScoreThreshold) {
                return null;
            }
            // Req 4.4: HIGH if Z-score > 2× threshold
            const severity = zScore > zScoreThreshold * 2 ? 'HIGH' : 'MEDIUM';
            // Req 4.6: confidence formula
            const confidence = Math.min(zScore / (zScoreThreshold * 2), 1.0);
            return {
                type: 'WHALE_ACTIVITY',
                severity,
                confidence,
                details: {
                    description: `Whale activity detected via Z-score: ${zScore.toFixed(2)}σ`,
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
        // Req 4.2: static liquidity percentage fallback
        const liquidityPercent = (trade.sizeUSDC / trade.orderBookLiquidity) * 100;
        if (liquidityPercent < staticThresholdPercent) {
            return null;
        }
        // Req 4.5: severity based on liquidity consumed
        let severity;
        if (liquidityPercent > 50) {
            severity = 'HIGH';
        }
        else if (liquidityPercent > 20) {
            severity = 'MEDIUM';
        }
        else {
            severity = 'LOW';
        }
        const confidence = Math.min(liquidityPercent / 100, 1.0);
        return {
            type: 'WHALE_ACTIVITY',
            severity,
            confidence,
            details: {
                description: `Whale activity detected via static threshold: ${liquidityPercent.toFixed(2)}% of liquidity`,
                metrics: {
                    liquidityPercent,
                    sizeUSDC: trade.sizeUSDC,
                    orderBookLiquidity: trade.orderBookLiquidity,
                    staticThresholdPercent,
                },
            },
            detectedAt: new Date(),
        };
    }
    // ─── Task 11.3: detectInsiderTrading ─────────────────────────────────────
    async detectInsiderTrading(trade) {
        const { insiderWalletAgeHours, insiderMinTradeSize, nicheMarketCategories, } = this.thresholds;
        // Req 5.1: check Redis cache before any Alchemy call
        let walletProfile = await this.redisCache.getWalletProfile(trade.walletAddress);
        if (!walletProfile) {
            walletProfile = await this.blockchainAnalyzer.analyzeWalletProfile(trade.walletAddress, this.redisCache);
        }
        const ageHours = walletProfile.ageHours;
        const transactionCount = walletProfile.transactionCount;
        // Req 5.6: all three conditions must be met
        const isNewWallet = ageHours !== null && ageHours < insiderWalletAgeHours;
        const isLargeTrade = trade.sizeUSDC >= insiderMinTradeSize;
        const isNicheMarket = trade.marketCategory !== undefined &&
            nicheMarketCategories.includes(trade.marketCategory);
        if (!isNewWallet || !isLargeTrade || !isNicheMarket) {
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
        let severity;
        if (confidence > 0.8) {
            severity = 'HIGH';
        }
        else if (confidence > 0.5) {
            severity = 'MEDIUM';
        }
        else {
            severity = 'LOW';
        }
        return {
            type: 'INSIDER_TRADING',
            severity,
            confidence,
            details: {
                description: `Insider trading pattern detected: new wallet (${ageHours?.toFixed(1)}h old) making large trade on niche market`,
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
    async analyze(trade) {
        const { rapidOddsShiftPercent, rapidOddsShiftWindowMinutes, whaleActivityPercent, zScoreThreshold, } = this.thresholds;
        // Fetch volatility and price history — fall back gracefully if TimescaleDB unavailable (Req 16.2)
        let volatility = null;
        let priceHistory = [];
        try {
            volatility = await this.timeSeriesDB.getMarketVolatility(trade.marketId, rapidOddsShiftWindowMinutes);
        }
        catch (err) {
            this.logger.warn('AnomalyDetector: getMarketVolatility failed, using static thresholds', {
                marketId: trade.marketId,
                error: String(err),
            });
        }
        try {
            const since = new Date(Date.now() - rapidOddsShiftWindowMinutes * 60 * 1000);
            priceHistory = await this.timeSeriesDB.getPriceHistory(trade.marketId, since);
        }
        catch (err) {
            this.logger.warn('AnomalyDetector: getPriceHistory failed, rapid odds shift using empty history', {
                marketId: trade.marketId,
                error: String(err),
            });
        }
        const results = [];
        // Run all three detectors
        const rapidOddsAnomaly = this.detectRapidOddsShift(trade, priceHistory, volatility, rapidOddsShiftPercent, zScoreThreshold);
        const whaleAnomaly = this.detectWhaleActivity(trade, volatility, whaleActivityPercent, zScoreThreshold);
        let insiderAnomaly = null;
        try {
            insiderAnomaly = await this.detectInsiderTrading(trade);
        }
        catch (err) {
            this.logger.warn('AnomalyDetector: detectInsiderTrading failed', {
                marketId: trade.marketId,
                error: String(err),
            });
        }
        for (const anomaly of [rapidOddsAnomaly, whaleAnomaly, insiderAnomaly]) {
            if (anomaly === null)
                continue;
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
exports.AnomalyDetector = AnomalyDetector;
//# sourceMappingURL=AnomalyDetector.js.map