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
  logger: Logger;
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
  return { detector, timeSeriesDB, redisCache, blockchainAnalyzer, logger };
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

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── detectCluster: below threshold ──────────────────────────────────────────

describe('no cluster when wallet count < clusterMinWallets (Req 6.3)', () => {
  it('returns null when 0 wallets returned', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    timeSeriesDB.getClusterWallets.mockResolvedValue([]);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis([]));

    const result = await detector.detectCluster(makeTrade());

    expect(result).toBeNull();
  });

  it('returns null when wallet count is exactly clusterMinWallets - 1 (2 wallets)', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    timeSeriesDB.getClusterWallets.mockResolvedValue(['0xA', '0xB']);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(['0xA', '0xB']));

    const result = await detector.detectCluster(makeTrade());

    expect(result).toBeNull();
  });
});

// ─── detectCluster: at or above threshold ────────────────────────────────────

describe('cluster returned when count >= clusterMinWallets (Req 6.3)', () => {
  it('returns ClusterAnomaly when wallet count equals clusterMinWallets (3)', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const result = await detector.detectCluster(makeTrade());

    expect(result).not.toBeNull();
    expect(result!.type).toBe('COORDINATED_MOVE');
    expect(result!.wallets).toHaveLength(3);
  });

  it('returns ClusterAnomaly when wallet count exceeds clusterMinWallets', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC', '0xD', '0xE'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(50000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const result = await detector.detectCluster(makeTrade());

    expect(result).not.toBeNull();
    expect(result!.wallets).toHaveLength(5);
  });

  it('result contains correct marketId, marketName, side, and windowMinutes', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const trade = makeTrade({ marketId: 'mkt-42', marketName: 'Election 2024', side: 'NO' });
    const result = await detector.detectCluster(trade);

    expect(result!.marketId).toBe('mkt-42');
    expect(result!.marketName).toBe('Election 2024');
    expect(result!.side).toBe('NO');
    expect(result!.windowMinutes).toBe(DEFAULT_THRESHOLDS.clusterWindowMinutes);
  });
});

// ─── detectCluster: deduplication of same wallet ─────────────────────────────

describe('same wallet trading multiple times counts as 1 distinct wallet (Req 6.8)', () => {
  it('deduplicates repeated wallets — 5 raw entries with 3 distinct wallets meets threshold', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    // 0xA appears twice, 0xB appears twice, 0xC once → 3 distinct
    timeSeriesDB.getClusterWallets.mockResolvedValue(['0xA', '0xA', '0xB', '0xB', '0xC']);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(
      makeNoFundingAnalysis(['0xA', '0xB', '0xC']),
    );

    const result = await detector.detectCluster(makeTrade());

    expect(result).not.toBeNull();
    expect(result!.wallets).toHaveLength(3);
    expect(result!.wallets).toEqual(expect.arrayContaining(['0xA', '0xB', '0xC']));
  });

  it('deduplicates repeated wallets — 4 raw entries with only 2 distinct wallets returns null', async () => {
    const { detector, timeSeriesDB } = makeDetector();
    // 0xA appears 3 times, 0xB once → only 2 distinct, below threshold of 3
    timeSeriesDB.getClusterWallets.mockResolvedValue(['0xA', '0xA', '0xA', '0xB']);

    const result = await detector.detectCluster(makeTrade());

    expect(result).toBeNull();
  });
});

// ─── detectCluster: trades outside time window ───────────────────────────────

describe('trades outside time window excluded (Req 6.2)', () => {
  it('only wallets within the window are counted — TimeSeriesDB filters by since date', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    // TimeSeriesDB is responsible for filtering by time window.
    // Simulate that only 2 wallets are within the window (old trades excluded).
    timeSeriesDB.getClusterWallets.mockResolvedValue(['0xA', '0xB']);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(['0xA', '0xB']));

    const result = await detector.detectCluster(makeTrade());

    // Only 2 wallets within window → below threshold → no cluster
    expect(result).toBeNull();
    // Verify getClusterWallets was called with a 'since' date
    expect(timeSeriesDB.getClusterWallets).toHaveBeenCalledWith(
      'market-1',
      'YES',
      expect.any(Date),
    );
  });

  it('since date is approximately clusterWindowMinutes ago', async () => {
    const { detector, timeSeriesDB } = makeDetector();
    timeSeriesDB.getClusterWallets.mockResolvedValue([]);

    const before = Date.now();
    await detector.detectCluster(makeTrade());
    const after = Date.now();

    const [, , sinceDate] = timeSeriesDB.getClusterWallets.mock.calls[0] as [string, string, Date];
    const sinceMs = sinceDate.getTime();
    const expectedMs = DEFAULT_THRESHOLDS.clusterWindowMinutes * 60 * 1000;

    expect(before - sinceMs).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - sinceMs).toBeLessThanOrEqual(expectedMs + 100);
  });
});

// ─── detectCluster: CRITICAL severity for common non-exchange funder ──────────

describe('CRITICAL severity when common non-exchange funder found (Req 6.5)', () => {
  it('returns CRITICAL when fundingAnalysis.hasCommonNonExchangeFunder is true', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(
      makeCommonFunderAnalysis(wallets, '0xFUNDER'),
    );

    const result = await detector.detectCluster(makeTrade());

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('CRITICAL');
  });

  it('attaches fundingAnalysis to the anomaly when CRITICAL', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    const funding = makeCommonFunderAnalysis(wallets, '0xFUNDER');
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(funding);

    const result = await detector.detectCluster(makeTrade());

    expect(result!.fundingAnalysis).toBeDefined();
    expect(result!.fundingAnalysis!.hasCommonNonExchangeFunder).toBe(true);
    expect(result!.fundingAnalysis!.commonFunderAddress).toBe('0xFUNDER');
  });

  it('does NOT return CRITICAL when funder is a known exchange', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    const exchangeFunding: FundingAnalysis = {
      wallets,
      funders: new Map(wallets.map(w => [w, '0xEXCHANGE'])),
      sharedFunders: new Map([['0xexchange', wallets]]),
      hasCommonNonExchangeFunder: false,
      commonFunderAddress: '0xEXCHANGE',
      isKnownExchange: true,
      exchangeName: 'Exchange',
    };
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(exchangeFunding);

    const result = await detector.detectCluster(makeTrade());

    expect(result!.severity).not.toBe('CRITICAL');
  });
});

// ─── detectCluster: HIGH / MEDIUM severity by wallet count ───────────────────

describe('HIGH for >= 5 wallets, MEDIUM for 3-4 wallets (Req 6.6)', () => {
  it('returns MEDIUM severity for exactly 3 wallets (no common funder)', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const result = await detector.detectCluster(makeTrade());

    expect(result!.severity).toBe('MEDIUM');
  });

  it('returns MEDIUM severity for exactly 4 wallets (no common funder)', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC', '0xD'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(40000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const result = await detector.detectCluster(makeTrade());

    expect(result!.severity).toBe('MEDIUM');
  });

  it('returns HIGH severity for exactly 5 wallets (no common funder)', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC', '0xD', '0xE'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(50000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const result = await detector.detectCluster(makeTrade());

    expect(result!.severity).toBe('HIGH');
  });

  it('returns HIGH severity for 6+ wallets (no common funder)', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC', '0xD', '0xE', '0xF'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(60000);
    blockchainAnalyzer.analyzeClusterFunding.mockResolvedValue(makeNoFundingAnalysis(wallets));

    const result = await detector.detectCluster(makeTrade());

    expect(result!.severity).toBe('HIGH');
  });
});

// ─── detectCluster: funding analysis failure degrades to HIGH ─────────────────

describe('funding analysis failure degrades to HIGH (non-blocking) (Req 6.8, Error Scenario 11)', () => {
  it('returns HIGH severity when analyzeClusterFunding throws', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockRejectedValue(new Error('Alchemy timeout'));

    const result = await detector.detectCluster(makeTrade());

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('HIGH');
  });

  it('still returns a ClusterAnomaly (non-blocking) when funding analysis fails', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockRejectedValue(new Error('Network error'));

    const result = await detector.detectCluster(makeTrade());

    expect(result).not.toBeNull();
    expect(result!.type).toBe('COORDINATED_MOVE');
    expect(result!.fundingAnalysis).toBeUndefined();
  });

  it('logs a warning when funding analysis fails', async () => {
    const { detector, timeSeriesDB, blockchainAnalyzer, logger } = makeDetector();
    const wallets = ['0xA', '0xB', '0xC'];
    timeSeriesDB.getClusterWallets.mockResolvedValue(wallets);
    timeSeriesDB.getClusterTotalSize.mockResolvedValue(30000);
    blockchainAnalyzer.analyzeClusterFunding.mockRejectedValue(new Error('Timeout'));

    await detector.detectCluster(makeTrade());

    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });
});

// ─── detectCluster: trade is recorded ────────────────────────────────────────

describe('trade is persisted on every detectCluster call (Req 6.1)', () => {
  it('calls recordClusterTrade with the incoming trade', async () => {
    const { detector, timeSeriesDB } = makeDetector();
    timeSeriesDB.getClusterWallets.mockResolvedValue([]);

    const trade = makeTrade();
    await detector.detectCluster(trade);

    expect(timeSeriesDB.recordClusterTrade).toHaveBeenCalledWith(trade);
  });
});
