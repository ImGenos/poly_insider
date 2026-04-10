/**
 * Task 20.6: Property test for graceful degradation on RPC failure
 *
 * Property 9: Graceful Degradation on RPC Failure
 * - For any Alchemy API failure, Analyzer continues detecting rapid odds shifts
 *   and whale activity without crashing.
 *
 * **Validates: Requirements 16.1**
 */

import * as fc from 'fast-check';
import { AnomalyDetector } from '../../src/detectors/AnomalyDetector';
import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { RedisCache } from '../../src/cache/RedisCache';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { Logger } from '../../src/utils/Logger';
import {
  FilteredTrade,
  DetectionThresholds,
  MarketVolatility,
  PricePoint,
} from '../../src/types/index';

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
  }));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

const THRESHOLDS: DetectionThresholds = {
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
  zScoreMinSamples: 30,
  zScoreBaselineWindow: 100,
};

const WALLET = '0xaAbBcCdDeEfF0011223344556677889900aAbBcC';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Valid price in (0, 1) */
const arbPrice = fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true });

/** Trade size in USDC */
const arbSizeUSDC = fc.float({ min: Math.fround(5001), max: Math.fround(1_000_000), noNaN: true });

/** Order book liquidity */
const arbLiquidity = fc.float({ min: Math.fround(1000), max: Math.fround(10_000_000), noNaN: true });

/** First price in history (for static threshold path) */
const arbFirstPrice = fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true });

/** Alchemy error messages */
const arbAlchemyError = fc.oneof(
  fc.constant('Alchemy API unavailable'),
  fc.constant('Alchemy HTTP error: 429'),
  fc.constant('Alchemy HTTP error: 503'),
  fc.constant('Alchemy RPC error: rate limit exceeded'),
  fc.constant('Network timeout'),
  fc.constant('ECONNREFUSED'),
  fc.constant('fetch failed'),
  fc.string({ minLength: 1, maxLength: 100 }),
);

function makeDetectorWithAlwaysFailingAlchemy(errorMessage: string): AnomalyDetector {
  const timeSeriesDB = {
    getMarketVolatility: jest.fn().mockResolvedValue({
      marketId: 'market-prop9',
      avgPrice: 0.5,
      stddevPrice: 0.0, // zero stddev → static path
      avgTradeSize: 5000,
      stddevTradeSize: 0,
      sampleCount: 5, // below ZSCORE_MIN_SAMPLES → static path
      lastUpdated: new Date(),
    } as MarketVolatility),
    getPriceHistory: jest.fn(),
    appendPricePoint: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<TimeSeriesDB>;

  const redisCache = {
    getWalletProfile: jest.fn().mockResolvedValue(null),
    saveWalletProfile: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<RedisCache>;

  // BlockchainAnalyzer always throws (simulating Alchemy failure)
  const blockchainAnalyzer = {
    analyzeWalletProfile: jest.fn().mockRejectedValue(new Error(errorMessage)),
  } as unknown as jest.Mocked<BlockchainAnalyzer>;

  return new AnomalyDetector(
    THRESHOLDS,
    timeSeriesDB as unknown as TimeSeriesDB,
    redisCache as unknown as RedisCache,
    blockchainAnalyzer as unknown as BlockchainAnalyzer,
    makeLogger(),
  );
}

// ─── Property 9: Graceful Degradation on RPC Failure ─────────────────────────

/**
 * Property 9: Graceful Degradation on RPC Failure
 *
 * For any Alchemy API failure (any error message), the AnomalyDetector:
 * 1. Does NOT throw or crash
 * 2. Still detects rapid odds shifts when price change exceeds static threshold
 * 3. Still detects whale activity when trade size exceeds static threshold
 *
 * **Validates: Requirements 16.1**
 */
describe('Property 9: Graceful Degradation on RPC Failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('analyze() never throws regardless of Alchemy error type', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPrice,
        arbSizeUSDC,
        arbLiquidity,
        arbFirstPrice,
        arbAlchemyError,
        async (price, sizeUSDC, liquidity, firstPrice, errorMessage) => {
          jest.clearAllMocks();

          const detector = makeDetectorWithAlwaysFailingAlchemy(errorMessage);

          // Set price history for static threshold path
          const timeSeriesDB = (detector as unknown as { timeSeriesDB: jest.Mocked<TimeSeriesDB> }).timeSeriesDB;
          timeSeriesDB.getPriceHistory.mockResolvedValue([
            { marketId: 'market-prop9', price: firstPrice, timestamp: new Date(Date.now() - 60000) },
          ] as PricePoint[]);

          const trade: FilteredTrade = {
            marketId: 'market-prop9',
            marketName: 'Property 9 Test Market',
            side: 'YES',
            price,
            sizeUSDC,
            timestamp: new Date(),
            walletAddress: WALLET,
            orderBookLiquidity: liquidity,
            marketCategory: 'sports',
          };

          // Must NOT throw
          let threw = false;
          try {
            await detector.analyze(trade);
          } catch {
            threw = true;
          }

          return !threw;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('detects rapid odds shift via static threshold when Alchemy fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAlchemyError,
        // firstPrice in (0.01, 0.4) so that price=0.9 gives > 15% change
        fc.float({ min: Math.fround(0.01), max: Math.fround(0.4), noNaN: true }),
        async (errorMessage, firstPrice) => {
          jest.clearAllMocks();

          const detector = makeDetectorWithAlwaysFailingAlchemy(errorMessage);

          const timeSeriesDB = (detector as unknown as { timeSeriesDB: jest.Mocked<TimeSeriesDB> }).timeSeriesDB;
          timeSeriesDB.getPriceHistory.mockResolvedValue([
            { marketId: 'market-prop9', price: firstPrice, timestamp: new Date(Date.now() - 60000) },
          ] as PricePoint[]);

          // price=0.9, firstPrice in (0.01, 0.4) → change > 125% >> 15% threshold
          const trade: FilteredTrade = {
            marketId: 'market-prop9',
            marketName: 'Property 9 Test Market',
            side: 'YES',
            price: 0.9,
            sizeUSDC: 10000,
            timestamp: new Date(),
            walletAddress: WALLET,
            orderBookLiquidity: 100000,
          };

          const anomalies = await detector.analyze(trade);
          return anomalies.some(a => a.type === 'RAPID_ODDS_SHIFT');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('detects whale activity via static threshold when Alchemy fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAlchemyError,
        // sizeUSDC > 20% of liquidity to trigger whale detection
        fc.float({ min: Math.fround(21000), max: Math.fround(100000), noNaN: true }), // sizeUSDC
        fc.float({ min: Math.fround(1000), max: Math.fround(50000), noNaN: true }),   // liquidity (< sizeUSDC)
        async (errorMessage, sizeUSDC, liquidity) => {
          // Ensure sizeUSDC > 20% of liquidity
          fc.pre(sizeUSDC / liquidity > 0.20);

          jest.clearAllMocks();

          const detector = makeDetectorWithAlwaysFailingAlchemy(errorMessage);

          const timeSeriesDB = (detector as unknown as { timeSeriesDB: jest.Mocked<TimeSeriesDB> }).timeSeriesDB;
          timeSeriesDB.getPriceHistory.mockResolvedValue([
            { marketId: 'market-prop9', price: 0.6, timestamp: new Date(Date.now() - 60000) },
          ] as PricePoint[]);

          const trade: FilteredTrade = {
            marketId: 'market-prop9',
            marketName: 'Property 9 Test Market',
            side: 'YES',
            price: 0.6,
            sizeUSDC,
            timestamp: new Date(),
            walletAddress: WALLET,
            orderBookLiquidity: liquidity,
          };

          const anomalies = await detector.analyze(trade);
          return anomalies.some(a => a.type === 'WHALE_ACTIVITY');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returned anomalies always have valid confidence [0,1] even when Alchemy fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPrice,
        arbSizeUSDC,
        arbLiquidity,
        arbFirstPrice,
        arbAlchemyError,
        async (price, sizeUSDC, liquidity, firstPrice, errorMessage) => {
          jest.clearAllMocks();

          const detector = makeDetectorWithAlwaysFailingAlchemy(errorMessage);

          const timeSeriesDB = (detector as unknown as { timeSeriesDB: jest.Mocked<TimeSeriesDB> }).timeSeriesDB;
          timeSeriesDB.getPriceHistory.mockResolvedValue([
            { marketId: 'market-prop9', price: firstPrice, timestamp: new Date(Date.now() - 60000) },
          ] as PricePoint[]);

          const trade: FilteredTrade = {
            marketId: 'market-prop9',
            marketName: 'Property 9 Test Market',
            side: 'YES',
            price,
            sizeUSDC,
            timestamp: new Date(),
            walletAddress: WALLET,
            orderBookLiquidity: liquidity,
          };

          const anomalies = await detector.analyze(trade);

          // All returned anomalies must have valid confidence
          return anomalies.every(a => a.confidence >= 0 && a.confidence <= 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('insider trading is NOT returned when Alchemy fails (graceful omission)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAlchemyError,
        async (errorMessage) => {
          jest.clearAllMocks();

          const detector = makeDetectorWithAlwaysFailingAlchemy(errorMessage);

          const timeSeriesDB = (detector as unknown as { timeSeriesDB: jest.Mocked<TimeSeriesDB> }).timeSeriesDB;
          timeSeriesDB.getPriceHistory.mockResolvedValue([
            { marketId: 'market-prop9', price: 0.6, timestamp: new Date(Date.now() - 60000) },
          ] as PricePoint[]);

          const trade: FilteredTrade = {
            marketId: 'market-prop9',
            marketName: 'Property 9 Test Market',
            side: 'YES',
            price: 0.6,
            sizeUSDC: 15000,
            timestamp: new Date(),
            walletAddress: WALLET,
            orderBookLiquidity: 100000,
            marketCategory: 'sports',
          };

          const anomalies = await detector.analyze(trade);

          // Insider trading requires wallet profile — when Alchemy fails and
          // Redis cache misses, detectInsiderTrading should be caught gracefully
          // (no crash), and insider anomaly should not appear
          const hasInsider = anomalies.some(a => a.type === 'INSIDER_TRADING');
          return !hasInsider; // insider should be absent when Alchemy fails
        },
      ),
      { numRuns: 50 },
    );
  });
});
