/**
 * Task 20.4: Graceful degradation integration test
 *
 * Validates: Requirements 16.1, 16.2, 16.4
 *
 * Tests:
 * - Analyzer continues with static thresholds when TimescaleDB unavailable (Req 16.2)
 * - Analyzer continues when Alchemy unavailable — no crash (Req 16.1)
 * - In-memory dedup fallback when Redis unavailable for alert dedup (Req 16.4)
 */

import { AnomalyDetector } from '../../src/detectors/AnomalyDetector';
import { RedisCache } from '../../src/cache/RedisCache';
import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { Logger } from '../../src/utils/Logger';
import {
  FilteredTrade,
  DetectionThresholds,
  WalletProfile,
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

function makeTrade(overrides: Partial<FilteredTrade> = {}): FilteredTrade {
  return {
    marketId: 'market-degrade',
    marketName: 'Degradation Test Market',
    side: 'YES',
    price: 0.9,
    sizeUSDC: 80000,
    timestamp: new Date(),
    walletAddress: WALLET,
    orderBookLiquidity: 100000,
    ...overrides,
  };
}

function makeWalletProfile(overrides: Partial<WalletProfile> = {}): WalletProfile {
  return {
    address: WALLET,
    firstTransactionTimestamp: Date.now() - 10 * 3600 * 1000,
    transactionCount: 2,
    ageHours: 10,
    isNew: true,
    riskScore: 80,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Req 16.2: TimescaleDB unavailable → static thresholds ───────────────────

describe('Graceful degradation — TimescaleDB unavailable (Req 16.2)', () => {
  it('AnomalyDetector continues detecting rapid odds shifts when getMarketVolatility throws', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockRejectedValue(new Error('TimescaleDB connection refused')),
      getPriceHistory: jest.fn().mockResolvedValue([
        { marketId: 'market-degrade', price: 0.1, timestamp: new Date(Date.now() - 60000) },
      ]),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    const redisCache = {
      getWalletProfile: jest.fn().mockResolvedValue(null),
      saveWalletProfile: jest.fn().mockResolvedValue(undefined),
      hasAlertBeenSent: jest.fn().mockResolvedValue(false),
      recordSentAlert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCache>;

    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockResolvedValue(makeWalletProfile({ ageHours: 1000, isNew: false })),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      redisCache as unknown as RedisCache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    // Trade with large price change from history (0.1 → 0.9 = 800%)
    const trade = makeTrade({ price: 0.9, sizeUSDC: 10000 });

    // Should NOT throw even though TimescaleDB is down
    let anomalies: Awaited<ReturnType<typeof detector.analyze>> = [];
    let threw = false;
    try {
      anomalies = await detector.analyze(trade);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Should still detect rapid odds shift via static threshold (price history from getPriceHistory)
    expect(anomalies.some(a => a.type === 'RAPID_ODDS_SHIFT')).toBe(true);
  });

  it('AnomalyDetector continues detecting whale activity when TimescaleDB throws', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockRejectedValue(new Error('TimescaleDB unavailable')),
      getPriceHistory: jest.fn().mockRejectedValue(new Error('TimescaleDB unavailable')),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    const redisCache = {
      getWalletProfile: jest.fn().mockResolvedValue(makeWalletProfile({ ageHours: 1000, isNew: false })),
      saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCache>;

    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockResolvedValue(makeWalletProfile({ ageHours: 1000, isNew: false })),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      redisCache as unknown as RedisCache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    // Whale trade: 80% of liquidity
    const trade = makeTrade({ sizeUSDC: 80000, orderBookLiquidity: 100000 });

    let anomalies: Awaited<ReturnType<typeof detector.analyze>> = [];
    let threw = false;
    try {
      anomalies = await detector.analyze(trade);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Whale activity should still be detected via static threshold
    expect(anomalies.some(a => a.type === 'WHALE_ACTIVITY')).toBe(true);
  });

  it('logs a warning when TimescaleDB is unavailable (Req 16.2)', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockRejectedValue(new Error('DB down')),
      getPriceHistory: jest.fn().mockResolvedValue([]),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    const redisCache = {
      getWalletProfile: jest.fn().mockResolvedValue(null),
      saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCache>;

    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockResolvedValue(makeWalletProfile()),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      redisCache as unknown as RedisCache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    await detector.analyze(makeTrade());

    expect((logger.warn as jest.Mock).mock.calls.some(
      (c: unknown[]) => String(c[0]).includes('getMarketVolatility failed') || String(c[0]).includes('static thresholds'),
    )).toBe(true);
  });
});

// ─── Req 16.1: Alchemy unavailable → no crash ────────────────────────────────

describe('Graceful degradation — Alchemy unavailable (Req 16.1)', () => {
  it('AnomalyDetector does NOT crash when BlockchainAnalyzer throws', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockResolvedValue({
        marketId: 'market-degrade',
        avgPriceChange: 0.5,
        stddevPriceChange: 0.05,
        avgTradeSize: 5000,
        stddevTradeSize: 1000,
        sampleCount: 5, // below min → static path
        lastUpdated: new Date(),
      }),
      getPriceHistory: jest.fn().mockResolvedValue([
        { marketId: 'market-degrade', price: 0.1, timestamp: new Date(Date.now() - 60000) },
      ]),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    const redisCache = {
      getWalletProfile: jest.fn().mockResolvedValue(null),
      saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCache>;

    // Alchemy always throws
    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockRejectedValue(new Error('Alchemy API unavailable')),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      redisCache as unknown as RedisCache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    const trade = makeTrade({ price: 0.9, sizeUSDC: 10000, marketCategory: 'sports' });

    // Must NOT throw
    let anomalies: Awaited<ReturnType<typeof detector.analyze>> = [];
    let threw = false;
    try {
      anomalies = await detector.analyze(trade);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Rapid odds shift and whale should still be detected
    expect(anomalies.some(a => a.type === 'RAPID_ODDS_SHIFT')).toBe(true);
  });

  it('continues detecting rapid odds shifts even when Alchemy fails (Req 16.1)', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockResolvedValue({
        marketId: 'market-degrade',
        avgPriceChange: 0.5,
        stddevPriceChange: 0.0,
        avgTradeSize: 5000,
        stddevTradeSize: 0,
        sampleCount: 5,
        lastUpdated: new Date(),
      }),
      getPriceHistory: jest.fn().mockResolvedValue([
        { marketId: 'market-degrade', price: 0.1, timestamp: new Date(Date.now() - 60000) },
      ]),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    const redisCache = {
      getWalletProfile: jest.fn().mockResolvedValue(null),
      saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCache>;

    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockRejectedValue(new Error('Alchemy 429 rate limit')),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      redisCache as unknown as RedisCache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    // Price 0.1 → 0.9 = 800% change >> 15% threshold
    const trade = makeTrade({ price: 0.9, sizeUSDC: 10000 });
    const anomalies = await detector.analyze(trade);

    expect(anomalies.some(a => a.type === 'RAPID_ODDS_SHIFT')).toBe(true);
  });

  it('continues detecting whale activity even when Alchemy fails (Req 16.1)', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockResolvedValue({
        marketId: 'market-degrade',
        avgPriceChange: 0.5,
        stddevPriceChange: 0.0,
        avgTradeSize: 5000,
        stddevTradeSize: 0,
        sampleCount: 5,
        lastUpdated: new Date(),
      }),
      getPriceHistory: jest.fn().mockResolvedValue([
        { marketId: 'market-degrade', price: 0.6, timestamp: new Date(Date.now() - 60000) },
      ]),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    const redisCache = {
      getWalletProfile: jest.fn().mockResolvedValue(null),
      saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCache>;

    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockRejectedValue(new Error('Alchemy network error')),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      redisCache as unknown as RedisCache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    // 80% of liquidity → whale
    const trade = makeTrade({ price: 0.6, sizeUSDC: 80000, orderBookLiquidity: 100000 });
    const anomalies = await detector.analyze(trade);

    expect(anomalies.some(a => a.type === 'WHALE_ACTIVITY')).toBe(true);
  });
});

// ─── Req 16.4: In-memory dedup fallback when Redis unavailable ────────────────

describe('Graceful degradation — in-memory dedup fallback (Req 16.4)', () => {
  it('hasAlertBeenSent returns false initially in fallback mode', async () => {
    // RedisCache with no connection → uses in-memory dedupMap
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    // Do NOT connect — stays in fallback mode

    const result = await cache.hasAlertBeenSent('WHALE_ACTIVITY', 'market-1', WALLET);

    expect(result).toBe(false);
  });

  it('recordSentAlert + hasAlertBeenSent works in-memory when Redis unavailable', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    // Not connected → in-memory fallback

    await cache.recordSentAlert('WHALE_ACTIVITY', 'market-1', WALLET, 3600);
    const result = await cache.hasAlertBeenSent('WHALE_ACTIVITY', 'market-1', WALLET);

    expect(result).toBe(true);
  });

  it('in-memory dedup is scoped per key — different keys are independent', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    await cache.recordSentAlert('WHALE_ACTIVITY', 'market-1', WALLET, 3600);

    // Different type — should NOT be marked as sent
    const result = await cache.hasAlertBeenSent('RAPID_ODDS_SHIFT', 'market-1', WALLET);
    expect(result).toBe(false);

    // Different market — should NOT be marked as sent
    const result2 = await cache.hasAlertBeenSent('WHALE_ACTIVITY', 'market-2', WALLET);
    expect(result2).toBe(false);
  });

  it('cluster alert dedup also works in-memory when Redis unavailable', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    await cache.recordClusterAlert('market-1', 'YES', 3600);
    const result = await cache.hasClusterAlertBeenSent('market-1', 'YES');

    expect(result).toBe(true);
  });

  it('cluster alert dedup is scoped — different market/side not affected', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    await cache.recordClusterAlert('market-1', 'YES', 3600);

    expect(await cache.hasClusterAlertBeenSent('market-1', 'NO')).toBe(false);
    expect(await cache.hasClusterAlertBeenSent('market-2', 'YES')).toBe(false);
  });

  it('AnomalyDetector does not crash when RedisCache getWalletProfile returns null (fallback)', async () => {
    const timeSeriesDB = {
      getMarketVolatility: jest.fn().mockResolvedValue({
        marketId: 'market-degrade',
        avgPriceChange: 0.5,
        stddevPriceChange: 0.0,
        avgTradeSize: 5000,
        stddevTradeSize: 0,
        sampleCount: 5,
        lastUpdated: new Date(),
      }),
      getPriceHistory: jest.fn().mockResolvedValue([
        { marketId: 'market-degrade', price: 0.6, timestamp: new Date(Date.now() - 60000) },
      ]),
      appendPricePoint: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TimeSeriesDB>;

    // Use real RedisCache in fallback mode (not connected)
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    const blockchainAnalyzer = {
      analyzeWalletProfile: jest.fn().mockResolvedValue(makeWalletProfile({ ageHours: 1000, isNew: false })),
    } as unknown as jest.Mocked<BlockchainAnalyzer>;

    const logger = makeLogger();
    const detector = new AnomalyDetector(
      THRESHOLDS,
      timeSeriesDB as unknown as TimeSeriesDB,
      cache,
      blockchainAnalyzer as unknown as BlockchainAnalyzer,
      logger,
    );

    const trade = makeTrade({ sizeUSDC: 80000 });

    await expect(detector.analyze(trade)).resolves.not.toThrow();
  });
});
