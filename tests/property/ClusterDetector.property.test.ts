import * as fc from 'fast-check';
import { ClusterDetector } from '../../src/detectors/ClusterDetector';
import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { RedisCache } from '../../src/cache/RedisCache';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { Logger } from '../../src/utils/Logger';
import {
  FilteredTrade,
  DetectionThresholds,
  FundingAnalysis,
} from '../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  zScoreMinSamples: 30,
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
    recordClusterTrade: jest.fn().mockResolvedValue(undefined),
    getClusterWallets: jest.fn().mockResolvedValue([]),
    getClusterTotalSize: jest.fn().mockResolvedValue(0),
    appendPricePoint: jest.fn(),
    getPriceHistory: jest.fn(),
    getMarketVolatility: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as jest.Mocked<TimeSeriesDB>;
}

function makeRedisCache(): jest.Mocked<RedisCache> {
  return {
    hasClusterAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordClusterAlert: jest.fn().mockResolvedValue(undefined),
    getWalletProfile: jest.fn().mockResolvedValue(null),
    saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    getWalletFunder: jest.fn().mockResolvedValue(null),
    cacheWalletFunder: jest.fn().mockResolvedValue(undefined),
    hasAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordSentAlert: jest.fn().mockResolvedValue(undefined),
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

function makeNoFundingAnalysis(wallets: string[]): FundingAnalysis {
  return {
    wallets,
    funders: new Map(),
    sharedFunders: new Map(),
    hasCommonNonExchangeFunder: false,
    commonFunderAddress: null,
    isKnownExchange: false,
    exchangeName: null,
  };
}

function makeCommonFunderAnalysis(wallets: string[], funderAddress: string): FundingAnalysis {
  const funders = new Map<string, string>();
  wallets.forEach(w => funders.set(w, funderAddress));
  const sharedFunders = new Map<string, string[]>();
  sharedFunders.set(funderAddress.toLowerCase(), wallets);
  return {
    wallets,
    funders,
    sharedFunders,
    hasCommonNonExchangeFunder: true,
    commonFunderAddress: funderAddress,
    isKnownExchange: false,
    exchangeName: null,
  };
}

function makeDetector(thresholds: Partial<DetectionThresholds> = {}): {
  detector: ClusterDetector;
  timeSeriesDB: jest.Mocked<TimeSeriesDB>;
  redisCache: jest.Mocked<RedisCache>;
  blockchainAnalyzer: jest.Mocked<BlockchainAnalyzer>;
} {
  const timeSeriesDB = makeTimeSeriesDB();
  const redisCache = makeRedisCache();
  const blockchainAnalyzer = makeBlockchainAnalyzer();
  const logger = makeLogger();
  const detector = new ClusterDetector(
    { ...DEFAULT_THRESHOLDS, ...thresholds },
    timeSeriesDB,
    redisCache,
    blockchainAnalyzer,
    logger,
  );
  return { detector, timeSeriesDB, redisCache, blockchainAnalyzer };
}

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

// ─── Property 13: Cluster Wallet Distinctness ─────────────────────────────────

/**
 * Property 13: Cluster Wallet Distinctness
 *
 * All wallet addresses in ClusterAnomaly.wallets are distinct — no duplicates
 * regardless of what raw wallet list TimeSeriesDB returns.
 *
 * **Validates: Requirements 6.8**
 */
describe('Property 13: Cluster Wallet Distinctness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('result.wallets contains no duplicate addresses for any raw wallet list', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate raw wallet lists that may contain duplicates
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 3, maxLength: 20 }),
        async (rawWallets) => {
          jest.clearAllMocks();

          const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();

          // Return the raw (potentially duplicate) wallet list from DB
          timeSeriesDB.getClusterWallets.mockResolvedValue(rawWallets);
          timeSeriesDB.getClusterTotalSize.mockResolvedValue(10000);

          // Compute distinct wallets to set up funding analysis
          const distinctWallets = [...new Set(rawWallets)];
          blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(
            makeNoFundingAnalysis(distinctWallets),
          );

          const result = await detector.detectCluster(makeTrade());

          // If below threshold, result is null — that's fine, skip
          if (result === null) return true;

          // Verify no duplicates in result.wallets
          const unique = new Set(result.wallets);
          return unique.size === result.wallets.length;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 12: Cluster Detection Threshold Monotonicity ───────────────────

/**
 * Property 12: Cluster Detection Threshold Monotonicity
 *
 * Clusters detected with threshold t2 >= t1 is always <= clusters with t1.
 * Equivalently: if a cluster is detected with a higher threshold t2, it must
 * also be detected with the lower threshold t1.
 *
 * **Validates: Requirements 6.3, 6.4**
 */
describe('Property 12: Cluster Detection Threshold Monotonicity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('if cluster detected with threshold t2, it is also detected with t1 <= t2', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }), // t1
        fc.integer({ min: 2, max: 10 }), // t2
        // Fixed set of distinct wallets (between 2 and 10)
        fc.integer({ min: 2, max: 10 }),
        async (t1Raw, t2Raw, walletCount) => {
          jest.clearAllMocks();

          // Ensure t1 <= t2
          const t1 = Math.min(t1Raw, t2Raw);
          const t2 = Math.max(t1Raw, t2Raw);

          // Build a fixed set of distinct wallets
          const wallets = Array.from({ length: walletCount }, (_, i) => `wallet-${i}`);

          // ── Run with threshold t2 ──────────────────────────────────────
          const { detector: detectorT2, timeSeriesDB: dbT2, blockchainAnalyzer: baT2 } =
            makeDetector({ clusterMinWallets: t2 });

          dbT2.getClusterWallets.mockResolvedValue(wallets);
          dbT2.getClusterTotalSize.mockResolvedValue(walletCount * 1000);
          baT2.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

          const resultT2 = await detectorT2.detectCluster(makeTrade());

          // ── Run with threshold t1 ──────────────────────────────────────
          const { detector: detectorT1, timeSeriesDB: dbT1, blockchainAnalyzer: baT1 } =
            makeDetector({ clusterMinWallets: t1 });

          dbT1.getClusterWallets.mockResolvedValue(wallets);
          dbT1.getClusterTotalSize.mockResolvedValue(walletCount * 1000);
          baT1.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

          const resultT1 = await detectorT1.detectCluster(makeTrade());

          // Monotonicity: if t2 detects a cluster, t1 must also detect one
          // (since t1 <= t2, a lower threshold is at least as permissive)
          if (resultT2 !== null) {
            return resultT1 !== null;
          }

          // If t2 doesn't detect, no constraint on t1
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 17: CRITICAL Severity Upgrade Conditions ───────────────────────

/**
 * Property 17: CRITICAL Severity Upgrade Conditions
 *
 * severity === 'CRITICAL' iff fundingAnalysis.hasCommonNonExchangeFunder === true.
 * When hasCommonNonExchangeFunder is false, severity must NOT be CRITICAL.
 *
 * **Validates: Requirements 6.5, 6.6**
 */
describe('Property 17: CRITICAL Severity Upgrade Conditions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('severity is CRITICAL iff hasCommonNonExchangeFunder is true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // hasCommonNonExchangeFunder
        async (hasCommonNonExchangeFunder) => {
          jest.clearAllMocks();

          const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();

          // Use exactly 3 wallets (meets minimum threshold of 3, below HIGH threshold of 5)
          const wallets = ['wallet-A', 'wallet-B', 'wallet-C'];
          timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
          timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);

          const fundingAnalysis: FundingAnalysis = hasCommonNonExchangeFunder
            ? makeCommonFunderAnalysis(wallets, '0xFUNDER')
            : makeNoFundingAnalysis(wallets);

          blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(fundingAnalysis);

          const result = await detector.detectCluster(makeTrade());

          // A cluster must be detected (3 wallets >= clusterMinWallets of 3)
          if (result === null) return false;

          if (hasCommonNonExchangeFunder) {
            // Must be CRITICAL
            return result.severity === 'CRITICAL';
          } else {
            // Must NOT be CRITICAL
            return result.severity !== 'CRITICAL';
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
