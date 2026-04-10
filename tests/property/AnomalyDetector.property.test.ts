import * as fc from 'fast-check';
import { AnomalyDetector } from '../../src/detectors/AnomalyDetector';
import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { RedisCache } from '../../src/cache/RedisCache';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { Logger } from '../../src/utils/Logger';
import {
  FilteredTrade,
  MarketVolatility,
  PricePoint,
  WalletProfile,
  DetectionThresholds,
} from '../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ZSCORE_MIN_SAMPLES = 30;

const DEFAULT_THRESHOLDS: DetectionThresholds = {
  minTradeSizeUSDC: 5000,
  rapidOddsShiftPercent: 15,
  rapidOddsShiftWindowMinutes: 5,
  whaleActivityPercent: 20,
  insiderWalletAgeHours: 48,
  insiderMinTradeSize: 10000,
  nicheMarketCategories: ['sports', 'crypto'],
  clusterWindowMinutes: 10,
  clusterMinWallets: 3,
  zScoreThreshold: 3.0,
  zScoreMinSamples: ZSCORE_MIN_SAMPLES,
  zScoreBaselineWindow: 100,
};

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

function makeTimeSeriesDB(): jest.Mocked<TimeSeriesDB> {
  return {
    getMarketVolatility: jest.fn(),
    getPriceHistory: jest.fn(),
    appendPricePoint: jest.fn(),
    recordClusterTrade: jest.fn(),
    getClusterWallets: jest.fn(),
    getClusterTotalSize: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as jest.Mocked<TimeSeriesDB>;
}

function makeRedisCache(): jest.Mocked<RedisCache> {
  return {
    getWalletProfile: jest.fn().mockResolvedValue(null),
    saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    getWalletFunder: jest.fn().mockResolvedValue(null),
    cacheWalletFunder: jest.fn().mockResolvedValue(undefined),
    hasAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordSentAlert: jest.fn().mockResolvedValue(undefined),
    hasClusterAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordClusterAlert: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: true,
  } as unknown as jest.Mocked<RedisCache>;
}

function makeBlockchainAnalyzer(): jest.Mocked<BlockchainAnalyzer> {
  return {
    analyzeWalletProfile: jest.fn(),
    getWalletFunder: jest.fn(),
    analyzeClusterFunding: jest.fn(),
  } as unknown as jest.Mocked<BlockchainAnalyzer>;
}

function makeDetector(thresholds: Partial<DetectionThresholds> = {}): {
  detector: AnomalyDetector;
  timeSeriesDB: jest.Mocked<TimeSeriesDB>;
  redisCache: jest.Mocked<RedisCache>;
  blockchainAnalyzer: jest.Mocked<BlockchainAnalyzer>;
} {
  const timeSeriesDB = makeTimeSeriesDB();
  const redisCache = makeRedisCache();
  const blockchainAnalyzer = makeBlockchainAnalyzer();
  const logger = makeLogger();
  const detector = new AnomalyDetector(
    { ...DEFAULT_THRESHOLDS, ...thresholds },
    timeSeriesDB,
    redisCache,
    blockchainAnalyzer,
    logger,
  );
  return { detector, timeSeriesDB, redisCache, blockchainAnalyzer };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A valid price in (0, 1) — avoids 0 to prevent division-by-zero in static path */
const arbPrice = fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true });

/** A positive trade size in USDC */
const arbSizeUSDC = fc.float({ min: Math.fround(1), max: Math.fround(1_000_000), noNaN: true });

/** A positive order-book liquidity value */
const arbLiquidity = fc.float({ min: Math.fround(1), max: Math.fround(10_000_000), noNaN: true });

/** A positive stddev (> 0 so Z-score path is active) */
const arbStddev = fc.float({ min: Math.fround(0.001), max: Math.fround(100), noNaN: true });

/** A positive mean */
const arbMean = fc.float({ min: Math.fround(0.001), max: Math.fround(1000), noNaN: true });

/** A sample count that activates Z-score path */
const arbSampleCountAbove = fc.integer({ min: ZSCORE_MIN_SAMPLES, max: 1000 });

/** A sample count that forces static fallback (below ZSCORE_MIN_SAMPLES) */
const arbSampleCountBelow = fc.integer({ min: 0, max: ZSCORE_MIN_SAMPLES - 1 });

function makeTrade(overrides: Partial<FilteredTrade> = {}): FilteredTrade {
  return {
    marketId: 'market-1',
    marketName: 'Test Market',
    side: 'YES',
    price: 0.6,
    sizeUSDC: 10000,
    timestamp: new Date(),
    walletAddress: '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
    orderBookLiquidity: 100000,
    ...overrides,
  };
}

function makePriceHistory(firstPrice: number): PricePoint[] {
  return [{ marketId: 'market-1', price: firstPrice, timestamp: new Date(Date.now() - 60000) }];
}

function makeVolatility(overrides: Partial<MarketVolatility> = {}): MarketVolatility {
  return {
    marketId: 'market-1',
    avgPrice: 0.5,
    stddevPrice: 0.05,
    avgTradeSize: 5000,
    stddevTradeSize: 1000,
    sampleCount: 50,
    lastUpdated: new Date(),
    ...overrides,
  };
}

// ─── Property 7: Confidence Score Bounds ─────────────────────────────────────

/**
 * Property 7: Confidence Score Bounds
 *
 * For any anomaly produced by detectRapidOddsShift or detectWhaleActivity,
 * anomaly.confidence is always in [0, 1].
 *
 * **Validates: Requirements 15.3**
 */
describe('Property 7: Confidence Score Bounds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('detectRapidOddsShift: confidence is always in [0, 1] for any non-null result', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbMean,
        arbStddev,
        arbSampleCountAbove,
        fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true }), // zScoreThreshold
        (price, mean, stddev, sampleCount, zScoreThreshold) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ price });
          const volatility = makeVolatility({
            avgPrice: mean,
            stddevPrice: stddev,
            sampleCount,
          });
          const priceHistory = makePriceHistory(mean > 0 ? mean * 0.5 : 0.1);

          const result = detector.detectRapidOddsShift(
            trade, priceHistory, volatility, 15, zScoreThreshold,
          );

          if (result === null) return true;
          return result.confidence >= 0 && result.confidence <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detectRapidOddsShift static path: confidence is always in [0, 1]', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbPrice, // firstPrice
        fc.float({ min: Math.fround(1), max: Math.fround(50), noNaN: true }), // staticThresholdPercent
        (price, firstPrice, staticThresholdPercent) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ price });
          const priceHistory = makePriceHistory(firstPrice);

          const result = detector.detectRapidOddsShift(
            trade, priceHistory, null, staticThresholdPercent, 3.0,
          );

          if (result === null) return true;
          return result.confidence >= 0 && result.confidence <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detectWhaleActivity Z-score path: confidence is always in [0, 1]', () => {
    fc.assert(
      fc.property(
        arbSizeUSDC,
        arbLiquidity,
        arbMean,
        arbStddev,
        arbSampleCountAbove,
        fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true }), // zScoreThreshold
        (sizeUSDC, liquidity, avgTradeSize, stddevTradeSize, sampleCount, zScoreThreshold) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ sizeUSDC, orderBookLiquidity: liquidity });
          const volatility = makeVolatility({
            avgTradeSize,
            stddevTradeSize,
            sampleCount,
          });

          const result = detector.detectWhaleActivity(
            trade, volatility, 20, zScoreThreshold,
          );

          if (result === null) return true;
          return result.confidence >= 0 && result.confidence <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detectWhaleActivity static path: confidence is always in [0, 1]', () => {
    fc.assert(
      fc.property(
        arbSizeUSDC,
        arbLiquidity,
        fc.float({ min: Math.fround(1), max: Math.fround(50), noNaN: true }), // staticThresholdPercent
        (sizeUSDC, liquidity, staticThresholdPercent) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ sizeUSDC, orderBookLiquidity: liquidity });

          const result = detector.detectWhaleActivity(
            trade, null, staticThresholdPercent, 3.0,
          );

          if (result === null) return true;
          return result.confidence >= 0 && result.confidence <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 15: Z-Score Detection Threshold ────────────────────────────────

/**
 * Property 15: Z-Score Baseline Accuracy
 *
 * Anomalies are triggered at exactly ZSCORE_THRESHOLD sigma, not below.
 * For any zScoreThreshold, an anomaly is returned iff Z-score >= threshold.
 *
 * **Validates: Requirements 3.1, 3.2, 4.1, 4.2, 8.3, 8.4**
 */
describe('Property 15: Z-Score Baseline Accuracy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('detectRapidOddsShift: anomaly returned iff Z-score >= threshold', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true }), // zScoreThreshold
        arbMean,
        arbStddev,
        arbSampleCountAbove,
        arbPrice,
        (zScoreThreshold, mean, stddev, sampleCount, price) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ price });
          const volatility = makeVolatility({
            avgPrice: mean,
            stddevPrice: stddev,
            sampleCount,
          });
          const priceHistory = makePriceHistory(0.5);

          const result = detector.detectRapidOddsShift(
            trade, priceHistory, volatility, 15, zScoreThreshold,
          );

          // The implementation uses signed Z-score: (price - mean) / stddev
          // An anomaly is returned iff zScore >= threshold (not absolute value)
          const zScore = (price - mean) / stddev;

          if (zScore >= zScoreThreshold) {
            // Anomaly must be returned
            return result !== null && result.type === 'RAPID_ODDS_SHIFT';
          } else {
            // No anomaly
            return result === null;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('detectWhaleActivity: anomaly returned iff Z-score >= threshold', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true }), // zScoreThreshold
        arbMean,
        arbStddev,
        arbSampleCountAbove,
        arbSizeUSDC,
        arbLiquidity,
        (zScoreThreshold, avgTradeSize, stddevTradeSize, sampleCount, sizeUSDC, liquidity) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ sizeUSDC, orderBookLiquidity: liquidity });
          const volatility = makeVolatility({
            avgTradeSize,
            stddevTradeSize,
            sampleCount,
          });

          const result = detector.detectWhaleActivity(
            trade, volatility, 20, zScoreThreshold,
          );

          // Compute expected Z-score
          const zScore = (sizeUSDC - avgTradeSize) / stddevTradeSize;

          if (zScore >= zScoreThreshold) {
            return result !== null && result.type === 'WHALE_ACTIVITY';
          } else {
            return result === null;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── Property 16: Z-Score Static Fallback ────────────────────────────────────

/**
 * Property 16: Z-Score Static Fallback
 *
 * When sampleCount < ZSCORE_MIN_SAMPLES (30), only static thresholds are used.
 * The result metrics must NOT contain a zScore field.
 *
 * **Validates: Requirements 3.1, 3.2, 4.1, 4.2, 8.3, 8.4**
 */
describe('Property 16: Z-Score Static Fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('detectRapidOddsShift: no zScore in metrics when sampleCount < ZSCORE_MIN_SAMPLES', () => {
    fc.assert(
      fc.property(
        arbSampleCountBelow,
        arbPrice,
        arbPrice, // firstPrice
        (sampleCount, price, firstPrice) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ price });
          const volatility = makeVolatility({
            sampleCount,
            stddevPrice: 0.05, // non-zero, but sampleCount is too low
          });
          const priceHistory = makePriceHistory(firstPrice);

          const result = detector.detectRapidOddsShift(
            trade, priceHistory, volatility, 15, 3.0,
          );

          if (result === null) return true;
          // Static path must not include zScore in metrics
          return !('zScore' in result.details.metrics);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detectWhaleActivity: no zScore in metrics when sampleCount < ZSCORE_MIN_SAMPLES', () => {
    fc.assert(
      fc.property(
        arbSampleCountBelow,
        arbSizeUSDC,
        arbLiquidity,
        (sampleCount, sizeUSDC, liquidity) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ sizeUSDC, orderBookLiquidity: liquidity });
          const volatility = makeVolatility({
            sampleCount,
            stddevTradeSize: 1000, // non-zero, but sampleCount is too low
          });

          const result = detector.detectWhaleActivity(
            trade, volatility, 20, 3.0,
          );

          if (result === null) return true;
          // Static path must not include zScore in metrics
          return !('zScore' in result.details.metrics);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detectRapidOddsShift: no zScore in metrics when volatility is null', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbPrice,
        (price, firstPrice) => {
          const { detector } = makeDetector();
          const trade = makeTrade({ price });
          const priceHistory = makePriceHistory(firstPrice);

          const result = detector.detectRapidOddsShift(
            trade, priceHistory, null, 15, 3.0,
          );

          if (result === null) return true;
          return !('zScore' in result.details.metrics);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: Anomaly Detection Completeness ──────────────────────────────

/**
 * Property 2: Anomaly Detection Completeness
 *
 * For any trade with known anomalous characteristics for all three types
 * simultaneously, analyze() returns all three anomaly types.
 *
 * **Validates: Requirements 3.1, 4.1, 5.6**
 */
describe('Property 2: Anomaly Detection Completeness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('analyze() returns all three anomaly types when trade is anomalous for all three simultaneously', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Vary the wallet age (must be < 48h for insider detection)
        fc.float({ min: Math.fround(0.1), max: Math.fround(47), noNaN: true }),
        // Vary the transaction count
        fc.integer({ min: 0, max: 10 }),
        async (walletAgeHours, txCount) => {
          jest.clearAllMocks();

          const { detector, timeSeriesDB, redisCache } = makeDetector();

          // ── Construct a trade anomalous for all three detectors ──────────
          //
          // RAPID_ODDS_SHIFT (static path): price far from firstPrice
          //   firstPrice=0.1, trade.price=0.9 → 800% change >> 15% threshold
          //
          // WHALE_ACTIVITY (static path): sizeUSDC >> liquidity threshold
          //   sizeUSDC=80000, liquidity=100000 → 80% >> 20% threshold
          //
          // INSIDER_TRADING: new wallet + large trade + niche market
          //   walletAgeHours < 48, sizeUSDC >= 10000, marketCategory='sports'
          const trade: FilteredTrade = {
            marketId: 'market-completeness',
            marketName: 'Completeness Test Market',
            side: 'YES',
            price: 0.9,
            sizeUSDC: 80000,
            timestamp: new Date(),
            walletAddress: '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
            orderBookLiquidity: 100000,
            marketCategory: 'sports',
          };

          // Static path: volatility with insufficient samples
          const volatility: MarketVolatility = {
            marketId: 'market-completeness',
            avgPrice: 0.5,
            stddevPrice: 0.05,
            avgTradeSize: 5000,
            stddevTradeSize: 1000,
            sampleCount: 5, // below ZSCORE_MIN_SAMPLES → static path
            lastUpdated: new Date(),
          };

          // Price history starting at 0.1 → 800% change triggers RAPID_ODDS_SHIFT
          const priceHistory: PricePoint[] = [
            { marketId: 'market-completeness', price: 0.1, timestamp: new Date(Date.now() - 60000) },
          ];

          // Mock TimeSeriesDB to return the above volatility and price history
          timeSeriesDB.getMarketVolatility.mockResolvedValue(volatility);
          timeSeriesDB.getPriceHistory.mockResolvedValue(priceHistory);

          // Mock wallet profile: new wallet satisfying insider conditions
          const walletProfile: WalletProfile = {
            address: trade.walletAddress,
            firstTransactionTimestamp: Date.now() - walletAgeHours * 3600 * 1000,
            transactionCount: txCount,
            ageHours: walletAgeHours,
            isNew: true,
            riskScore: 80,
          };
          redisCache.getWalletProfile.mockResolvedValue(walletProfile);

          const results = await detector.analyze(trade);

          const types = results.map(a => a.type);

          return (
            types.includes('RAPID_ODDS_SHIFT') &&
            types.includes('WHALE_ACTIVITY') &&
            types.includes('INSIDER_TRADING')
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
