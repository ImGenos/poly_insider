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
  logger: Logger;
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

function makePriceHistory(firstPrice = 0.5, count = 5): PricePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    marketId: 'market-1',
    price: firstPrice,
    timestamp: new Date(Date.now() - (count - i) * 60000),
  }));
}

function makeWalletProfile(overrides: Partial<WalletProfile> = {}): WalletProfile {
  return {
    address: '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
    firstTransactionTimestamp: Date.now() - 10 * 3600 * 1000,
    transactionCount: 2,
    ageHours: 10,
    isNew: true,
    riskScore: 80,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── detectRapidOddsShift ─────────────────────────────────────────────────────

describe('detectRapidOddsShift', () => {
  describe('empty price history returns null (Req 3.6)', () => {
    it('returns null when priceHistory is empty', () => {
      const { detector } = makeDetector();
      const trade = makeTrade({ price: 0.9 });
      const result = detector.detectRapidOddsShift(trade, [], null, 15, 3.0);
      expect(result).toBeNull();
    });
  });

  describe('Z-score path (Req 3.1)', () => {
    it('returns RAPID_ODDS_SHIFT anomaly when Z-score exceeds threshold', () => {
      const { detector } = makeDetector();
      // avg=0.5, stddev=0.05 → Z-score of 0.9 = (0.9-0.5)/0.05 = 8.0 > 3.0
      const trade = makeTrade({ price: 0.9 });
      const volatility = makeVolatility({ avgPrice: 0.5, stddevPrice: 0.05, sampleCount: 50 });
      const priceHistory = makePriceHistory();

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('RAPID_ODDS_SHIFT');
      expect(result!.details.metrics.zScore).toBeCloseTo(8.0, 1);
    });

    it('returns null when Z-score is below threshold', () => {
      const { detector } = makeDetector();
      // avg=0.5, stddev=0.05 → Z-score of 0.51 = (0.51-0.5)/0.05 = 0.2 < 3.0
      const trade = makeTrade({ price: 0.51 });
      const volatility = makeVolatility({ avgPrice: 0.5, stddevPrice: 0.05, sampleCount: 50 });
      const priceHistory = makePriceHistory();

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result).toBeNull();
    });

    it('assigns HIGH severity when Z-score > 2× threshold', () => {
      const { detector } = makeDetector();
      // Z-score = (0.9-0.5)/0.05 = 8.0 > 6.0 (2×3.0)
      const trade = makeTrade({ price: 0.9 });
      const volatility = makeVolatility({ avgPrice: 0.5, stddevPrice: 0.05, sampleCount: 50 });
      const priceHistory = makePriceHistory();

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result!.severity).toBe('HIGH');
    });

    it('assigns MEDIUM severity when Z-score is between threshold and 2× threshold', () => {
      const { detector } = makeDetector();
      // Z-score = (0.67-0.5)/0.05 = 3.4 — between 3.0 and 6.0
      const trade = makeTrade({ price: 0.67 });
      const volatility = makeVolatility({ avgPrice: 0.5, stddevPrice: 0.05, sampleCount: 50 });
      const priceHistory = makePriceHistory();

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result!.severity).toBe('MEDIUM');
    });

    it('confidence is capped at 1.0 for very high Z-scores', () => {
      const { detector } = makeDetector();
      // Z-score = (1.0-0.5)/0.05 = 10.0 → confidence = min(10/6, 1) = 1.0
      const trade = makeTrade({ price: 1.0 });
      const volatility = makeVolatility({ avgPrice: 0.5, stddevPrice: 0.05, sampleCount: 50 });
      const priceHistory = makePriceHistory();

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result!.confidence).toBe(1.0);
    });
  });

  describe('static threshold fallback (Req 3.2)', () => {
    it('uses static fallback when sampleCount < zScoreMinSamples', () => {
      const { detector } = makeDetector();
      // price history starts at 0.5, trade price is 0.9 → 80% change > 15%
      const trade = makeTrade({ price: 0.9 });
      const volatility = makeVolatility({ sampleCount: 10 }); // below 30
      const priceHistory = makePriceHistory(0.5);

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('RAPID_ODDS_SHIFT');
      expect(result!.details.metrics.priceChangePercent).toBeCloseTo(80, 0);
    });

    it('uses static fallback when volatility is null', () => {
      const { detector } = makeDetector();
      const trade = makeTrade({ price: 0.9 });
      const priceHistory = makePriceHistory(0.5);

      const result = detector.detectRapidOddsShift(trade, priceHistory, null, 15, 3.0);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('RAPID_ODDS_SHIFT');
    });

    it('uses static fallback when stddevPrice is 0', () => {
      const { detector } = makeDetector();
      const trade = makeTrade({ price: 0.9 });
      const volatility = makeVolatility({ stddevPrice: 0, sampleCount: 50 });
      const priceHistory = makePriceHistory(0.5);

      const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

      expect(result).not.toBeNull();
      expect(result!.details.metrics.priceChangePercent).toBeDefined();
    });

    it('returns null when static change is below threshold', () => {
      const { detector } = makeDetector();
      // 0.5 → 0.55 = 10% change < 15% threshold
      const trade = makeTrade({ price: 0.55 });
      const priceHistory = makePriceHistory(0.5);

      const result = detector.detectRapidOddsShift(trade, priceHistory, null, 15, 3.0);

      expect(result).toBeNull();
    });

    it('assigns HIGH severity when static change > 25%', () => {
      const { detector } = makeDetector();
      // 0.5 → 0.9 = 80% > 25%
      const trade = makeTrade({ price: 0.9 });
      const priceHistory = makePriceHistory(0.5);

      const result = detector.detectRapidOddsShift(trade, priceHistory, null, 15, 3.0);

      expect(result!.severity).toBe('HIGH');
    });

    it('assigns MEDIUM severity when static change is between threshold and 25%', () => {
      const { detector } = makeDetector();
      // 0.5 → 0.6 = 20% — between 15% and 25%
      const trade = makeTrade({ price: 0.6 });
      const priceHistory = makePriceHistory(0.5);

      const result = detector.detectRapidOddsShift(trade, priceHistory, null, 15, 3.0);

      expect(result!.severity).toBe('MEDIUM');
    });
  });
});

// ─── detectWhaleActivity ──────────────────────────────────────────────────────

describe('detectWhaleActivity', () => {
  describe('zero liquidity returns null (Req 4.3)', () => {
    it('returns null when orderBookLiquidity is 0', () => {
      const { detector } = makeDetector();
      const trade = makeTrade({ orderBookLiquidity: 0 });

      const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

      expect(result).toBeNull();
    });

    it('returns null when orderBookLiquidity is undefined', () => {
      const { detector } = makeDetector();
      const trade = makeTrade({ orderBookLiquidity: undefined as unknown as number });

      const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

      expect(result).toBeNull();
    });
  });

  describe('Z-score path (Req 4.1)', () => {
    it('returns WHALE_ACTIVITY anomaly when trade size Z-score exceeds threshold', () => {
      const { detector } = makeDetector();
      // avg=5000, stddev=1000 → Z-score of 50000 = (50000-5000)/1000 = 45 > 3.0
      const trade = makeTrade({ sizeUSDC: 50000, orderBookLiquidity: 500000 });
      const volatility = makeVolatility({ avgTradeSize: 5000, stddevTradeSize: 1000, sampleCount: 50 });

      const result = detector.detectWhaleActivity(trade, volatility, 20, 3.0);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('WHALE_ACTIVITY');
      expect(result!.details.metrics.zScore).toBeCloseTo(45, 0);
    });

    it('returns null when trade size Z-score is below threshold', () => {
      const { detector } = makeDetector();
      // avg=5000, stddev=1000 → Z-score of 5100 = 0.1 < 3.0
      const trade = makeTrade({ sizeUSDC: 5100, orderBookLiquidity: 500000 });
      const volatility = makeVolatility({ avgTradeSize: 5000, stddevTradeSize: 1000, sampleCount: 50 });

      const result = detector.detectWhaleActivity(trade, volatility, 20, 3.0);

      expect(result).toBeNull();
    });

    it('assigns HIGH severity when Z-score > 2× threshold', () => {
      const { detector } = makeDetector();
      // Z-score = (50000-5000)/1000 = 45 > 6.0
      const trade = makeTrade({ sizeUSDC: 50000, orderBookLiquidity: 500000 });
      const volatility = makeVolatility({ avgTradeSize: 5000, stddevTradeSize: 1000, sampleCount: 50 });

      const result = detector.detectWhaleActivity(trade, volatility, 20, 3.0);

      expect(result!.severity).toBe('HIGH');
    });

    it('assigns MEDIUM severity when Z-score is between threshold and 2× threshold', () => {
      const { detector } = makeDetector();
      // Z-score = (8500-5000)/1000 = 3.5 — between 3.0 and 6.0
      const trade = makeTrade({ sizeUSDC: 8500, orderBookLiquidity: 500000 });
      const volatility = makeVolatility({ avgTradeSize: 5000, stddevTradeSize: 1000, sampleCount: 50 });

      const result = detector.detectWhaleActivity(trade, volatility, 20, 3.0);

      expect(result!.severity).toBe('MEDIUM');
    });
  });

  describe('static threshold fallback (Req 4.2)', () => {
    it('uses static fallback when sampleCount < zScoreMinSamples', () => {
      const { detector } = makeDetector();
      // 30000 / 100000 = 30% > 20% threshold
      const trade = makeTrade({ sizeUSDC: 30000, orderBookLiquidity: 100000 });
      const volatility = makeVolatility({ sampleCount: 10 });

      const result = detector.detectWhaleActivity(trade, volatility, 20, 3.0);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('WHALE_ACTIVITY');
    });

    it('uses static fallback when volatility is null', () => {
      const { detector } = makeDetector();
      // 30000 / 100000 = 30% > 20%
      const trade = makeTrade({ sizeUSDC: 30000, orderBookLiquidity: 100000 });

      const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('WHALE_ACTIVITY');
    });

    it('returns null when liquidity percent is below static threshold', () => {
      const { detector } = makeDetector();
      // 5000 / 100000 = 5% < 20%
      const trade = makeTrade({ sizeUSDC: 5000, orderBookLiquidity: 100000 });

      const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

      expect(result).toBeNull();
    });

    it('assigns HIGH severity when liquidity consumed > 50%', () => {
      const { detector } = makeDetector();
      // 60000 / 100000 = 60% > 50%
      const trade = makeTrade({ sizeUSDC: 60000, orderBookLiquidity: 100000 });

      const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

      expect(result!.severity).toBe('HIGH');
    });

    it('assigns MEDIUM severity when liquidity consumed is between 20% and 50%', () => {
      const { detector } = makeDetector();
      // 30000 / 100000 = 30%
      const trade = makeTrade({ sizeUSDC: 30000, orderBookLiquidity: 100000 });

      const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

      expect(result!.severity).toBe('MEDIUM');
    });

    it('assigns LOW severity when liquidity consumed is between threshold and 20%', () => {
      const { detector } = makeDetector();
      // 15000 / 100000 = 15% — below 20% threshold, so returns null
      // Use threshold of 10% to get LOW
      const trade = makeTrade({ sizeUSDC: 15000, orderBookLiquidity: 100000 });

      const result = detector.detectWhaleActivity(trade, null, 10, 3.0);

      expect(result!.severity).toBe('LOW');
    });
  });
});

// ─── detectInsiderTrading ─────────────────────────────────────────────────────

describe('detectInsiderTrading', () => {
  function makeInsiderTrade(): FilteredTrade {
    return makeTrade({
      sizeUSDC: 15000,          // >= insiderMinTradeSize (10000)
      marketCategory: 'sports', // in nicheMarketCategories
    });
  }

  function makeNewWalletProfile(): WalletProfile {
    return makeWalletProfile({
      ageHours: 10,             // < insiderWalletAgeHours (48)
      transactionCount: 2,
    });
  }

  describe('all three conditions required (Req 5.6)', () => {
    it('returns INSIDER_TRADING when all three conditions are met', async () => {
      const { detector, redisCache } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(makeNewWalletProfile());

      const result = await detector.detectInsiderTrading(makeInsiderTrade());

      expect(result).not.toBeNull();
      expect(result!.type).toBe('INSIDER_TRADING');
    });

    it('returns null when wallet is NOT new (age >= insiderWalletAgeHours)', async () => {
      const { detector, redisCache } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(makeWalletProfile({ ageHours: 100 }));

      const result = await detector.detectInsiderTrading(makeInsiderTrade());

      expect(result).toBeNull();
    });

    it('returns null when trade size is below insiderMinTradeSize', async () => {
      const { detector, redisCache } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(makeNewWalletProfile());
      const trade = makeInsiderTrade();
      trade.sizeUSDC = 5000; // below 10000

      const result = await detector.detectInsiderTrading(trade);

      expect(result).toBeNull();
    });

    it('returns null when marketCategory is not in nicheMarketCategories', async () => {
      const { detector, redisCache } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(makeNewWalletProfile());
      const trade = makeInsiderTrade();
      trade.marketCategory = 'politics'; // not in ['sports', 'crypto']

      const result = await detector.detectInsiderTrading(trade);

      expect(result).toBeNull();
    });

    it('returns null when marketCategory is undefined', async () => {
      const { detector, redisCache } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(makeNewWalletProfile());
      const trade = makeInsiderTrade();
      trade.marketCategory = undefined;

      const result = await detector.detectInsiderTrading(trade);

      expect(result).toBeNull();
    });
  });

  describe('confidence formula (Req 5.7)', () => {
    it('confidence is a weighted combination of ageScore, sizeScore, activityScore', async () => {
      const { detector, redisCache } = makeDetector();
      // ageHours=10, insiderWalletAgeHours=48 → ageScore = 1 - 10/48 ≈ 0.792
      // sizeUSDC=15000, insiderMinTradeSize=10000 → sizeScore = min(15000/100000, 1) = 0.15
      // transactionCount=2 → activityScore = max(0, 1 - 2/100) = 0.98
      // confidence = 0.792*0.4 + 0.15*0.3 + 0.98*0.3 ≈ 0.317 + 0.045 + 0.294 = 0.656
      const profile = makeWalletProfile({ ageHours: 10, transactionCount: 2 });
      redisCache.getWalletProfile.mockResolvedValue(profile);

      const result = await detector.detectInsiderTrading(makeInsiderTrade());

      expect(result).not.toBeNull();
      const expectedAgeScore = 1 - 10 / 48;
      const expectedSizeScore = Math.min(15000 / 100000, 1.0);
      const expectedActivityScore = Math.max(0, 1 - 2 / 100);
      const expectedConfidence =
        expectedAgeScore * 0.4 + expectedSizeScore * 0.3 + expectedActivityScore * 0.3;
      expect(result!.confidence).toBeCloseTo(expectedConfidence, 5);
    });

    it('confidence is always in [0, 1]', async () => {
      const { detector, redisCache } = makeDetector();
      // Very new wallet, very large trade, zero transactions → high confidence
      const profile = makeWalletProfile({ ageHours: 0.1, transactionCount: 0 });
      redisCache.getWalletProfile.mockResolvedValue(profile);
      const trade = makeInsiderTrade();
      trade.sizeUSDC = 1_000_000; // huge trade

      const result = await detector.detectInsiderTrading(trade);

      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThanOrEqual(0);
      expect(result!.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('severity assignments (Req 5.8)', () => {
    it('assigns HIGH severity when confidence > 0.8', async () => {
      const { detector, redisCache } = makeDetector();
      // ageHours=1 → ageScore ≈ 0.979; sizeUSDC=100000 → sizeScore=1.0; txCount=0 → activityScore=1.0
      // confidence = 0.979*0.4 + 1.0*0.3 + 1.0*0.3 = 0.392 + 0.3 + 0.3 = 0.992 > 0.8
      const profile = makeWalletProfile({ ageHours: 1, transactionCount: 0 });
      redisCache.getWalletProfile.mockResolvedValue(profile);
      const trade = makeInsiderTrade();
      trade.sizeUSDC = 100000;

      const result = await detector.detectInsiderTrading(trade);

      expect(result!.severity).toBe('HIGH');
    });

    it('assigns MEDIUM severity when confidence is between 0.5 and 0.8', async () => {
      const { detector, redisCache } = makeDetector();
      // ageHours=24 → ageScore = 1 - 24/48 = 0.5; sizeUSDC=15000 → sizeScore=0.15; txCount=50 → activityScore=0.5
      // confidence = 0.5*0.4 + 0.15*0.3 + 0.5*0.3 = 0.2 + 0.045 + 0.15 = 0.395 — too low
      // Use txCount=5 → activityScore=0.95; ageHours=5 → ageScore≈0.896; sizeUSDC=50000 → sizeScore=0.5
      // confidence = 0.896*0.4 + 0.5*0.3 + 0.95*0.3 = 0.358 + 0.15 + 0.285 = 0.793 — still < 0.8
      // Use ageHours=2 → ageScore≈0.958; sizeUSDC=50000 → sizeScore=0.5; txCount=5 → activityScore=0.95
      // confidence = 0.958*0.4 + 0.5*0.3 + 0.95*0.3 = 0.383 + 0.15 + 0.285 = 0.818 > 0.8 → HIGH
      // Need MEDIUM: confidence in (0.5, 0.8)
      // ageHours=20 → ageScore=1-20/48≈0.583; sizeUSDC=15000 → sizeScore=0.15; txCount=10 → activityScore=0.9
      // confidence = 0.583*0.4 + 0.15*0.3 + 0.9*0.3 = 0.233 + 0.045 + 0.27 = 0.548 → MEDIUM
      const profile = makeWalletProfile({ ageHours: 20, transactionCount: 10 });
      redisCache.getWalletProfile.mockResolvedValue(profile);

      const result = await detector.detectInsiderTrading(makeInsiderTrade());

      expect(result!.severity).toBe('MEDIUM');
      expect(result!.confidence).toBeGreaterThan(0.5);
      expect(result!.confidence).toBeLessThanOrEqual(0.8);
    });

    it('assigns LOW severity when confidence <= 0.5', async () => {
      const { detector, redisCache } = makeDetector();
      // ageHours=47 → ageScore=1-47/48≈0.021; sizeUSDC=10000 → sizeScore=0.1; txCount=80 → activityScore=0.2
      // confidence = 0.021*0.4 + 0.1*0.3 + 0.2*0.3 = 0.008 + 0.03 + 0.06 = 0.098 → LOW
      const profile = makeWalletProfile({ ageHours: 47, transactionCount: 80 });
      redisCache.getWalletProfile.mockResolvedValue(profile);
      const trade = makeInsiderTrade();
      trade.sizeUSDC = 10000;

      const result = await detector.detectInsiderTrading(trade);

      expect(result!.severity).toBe('LOW');
      expect(result!.confidence).toBeLessThanOrEqual(0.5);
    });
  });

  describe('cache-first strategy (Req 5.1)', () => {
    it('uses cached wallet profile from Redis without calling blockchainAnalyzer', async () => {
      const { detector, redisCache, blockchainAnalyzer } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(makeNewWalletProfile());

      await detector.detectInsiderTrading(makeInsiderTrade());

      expect(blockchainAnalyzer.analyzeWalletProfile).not.toHaveBeenCalled();
    });

    it('calls blockchainAnalyzer when Redis cache misses', async () => {
      const { detector, redisCache, blockchainAnalyzer } = makeDetector();
      redisCache.getWalletProfile.mockResolvedValue(null);
      blockchainAnalyzer.analyzeWalletProfile.mockResolvedValue(makeNewWalletProfile());

      await detector.detectInsiderTrading(makeInsiderTrade());

      expect(blockchainAnalyzer.analyzeWalletProfile).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Confidence always in [0, 1] (Req 15.3) ──────────────────────────────────

describe('confidence always in [0, 1]', () => {
  it('detectRapidOddsShift Z-score path: confidence in [0, 1]', () => {
    const { detector } = makeDetector();
    const trade = makeTrade({ price: 0.9 });
    const volatility = makeVolatility({ avgPrice: 0.5, stddevPrice: 0.05, sampleCount: 50 });
    const priceHistory = makePriceHistory();

    const result = detector.detectRapidOddsShift(trade, priceHistory, volatility, 15, 3.0);

    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it('detectRapidOddsShift static path: confidence in [0, 1]', () => {
    const { detector } = makeDetector();
    const trade = makeTrade({ price: 0.9 });
    const priceHistory = makePriceHistory(0.5);

    const result = detector.detectRapidOddsShift(trade, priceHistory, null, 15, 3.0);

    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it('detectWhaleActivity Z-score path: confidence in [0, 1]', () => {
    const { detector } = makeDetector();
    const trade = makeTrade({ sizeUSDC: 50000, orderBookLiquidity: 500000 });
    const volatility = makeVolatility({ avgTradeSize: 5000, stddevTradeSize: 1000, sampleCount: 50 });

    const result = detector.detectWhaleActivity(trade, volatility, 20, 3.0);

    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it('detectWhaleActivity static path: confidence in [0, 1]', () => {
    const { detector } = makeDetector();
    const trade = makeTrade({ sizeUSDC: 60000, orderBookLiquidity: 100000 });

    const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it('detectInsiderTrading: confidence in [0, 1]', async () => {
    const { detector, redisCache } = makeDetector();
    redisCache.getWalletProfile.mockResolvedValue(makeWalletProfile({ ageHours: 10, transactionCount: 2 }));
    const trade = makeTrade({ sizeUSDC: 15000, marketCategory: 'sports' });

    const result = await detector.detectInsiderTrading(trade);

    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });
});

// ─── Severity assignments for each detection type ────────────────────────────

describe('severity assignments', () => {
  it('RAPID_ODDS_SHIFT uses MEDIUM or HIGH severity', () => {
    const { detector } = makeDetector();
    const trade = makeTrade({ price: 0.6 });
    const priceHistory = makePriceHistory(0.5);

    const result = detector.detectRapidOddsShift(trade, priceHistory, null, 15, 3.0);

    expect(['MEDIUM', 'HIGH']).toContain(result!.severity);
  });

  it('WHALE_ACTIVITY uses LOW, MEDIUM, or HIGH severity', () => {
    const { detector } = makeDetector();
    const trade = makeTrade({ sizeUSDC: 30000, orderBookLiquidity: 100000 });

    const result = detector.detectWhaleActivity(trade, null, 20, 3.0);

    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(result!.severity);
  });

  it('INSIDER_TRADING uses LOW, MEDIUM, or HIGH severity', async () => {
    const { detector, redisCache } = makeDetector();
    redisCache.getWalletProfile.mockResolvedValue(makeWalletProfile({ ageHours: 10, transactionCount: 2 }));
    const trade = makeTrade({ sizeUSDC: 15000, marketCategory: 'sports' });

    const result = await detector.detectInsiderTrading(trade);

    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(result!.severity);
  });
});
