import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Logger } from '../../src/utils/Logger';
import { RedisCache } from '../../src/cache/RedisCache';
import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { PolymarketAPI } from '../../src/blockchain/PolymarketAPI';
import { AnomalyDetector } from '../../src/detectors/AnomalyDetector';
import { FilteredTrade, DetectionThresholds } from '../../src/types/index';

/**
 * Integration test for hybrid anomaly detection approach
 * Tests both market-level (Polymarket API) and wallet-level (Alchemy) detection
 */
describe('Hybrid Anomaly Detection', () => {
  let logger: Logger;
  let redisCache: RedisCache;
  let timeSeriesDB: TimeSeriesDB;
  let blockchainAnalyzer: BlockchainAnalyzer;
  let polymarketAPI: PolymarketAPI;
  let anomalyDetector: AnomalyDetector;

  const thresholds: DetectionThresholds = {
    minTradeSizeUSDC: 1000,
    rapidOddsShiftPercent: 15,
    rapidOddsShiftWindowMinutes: 5,
    whaleActivityPercent: 20,
    insiderWalletAgeHours: 48,
    insiderMinTradeSize: 5000,
    nicheMarketCategories: ['crypto', 'politics'],
    clusterWindowMinutes: 10,
    clusterMinWallets: 3,
    zScoreThreshold: 3.0,
    zScoreMinSamples: 5,
    zScoreBaselineWindow: 100,
  };

  beforeAll(async () => {
    logger = new Logger('info', undefined);
    redisCache = new RedisCache(process.env.REDIS_URL || 'redis://localhost:6379', logger);
    timeSeriesDB = new TimeSeriesDB(
      process.env.TIMESCALEDB_URL || 'postgresql://polymarket:polymarket@localhost:5432/polymarket',
      logger
    );
    blockchainAnalyzer = new BlockchainAnalyzer(
      process.env.ALCHEMY_API_KEY || 'test-key',
      process.env.MORALIS_API_KEY || '',
      [],
      logger
    );
    polymarketAPI = new PolymarketAPI(logger);
    anomalyDetector = new AnomalyDetector(
      thresholds,
      timeSeriesDB,
      redisCache,
      blockchainAnalyzer,
      polymarketAPI,
      logger
    );

    await redisCache.connect();
    await timeSeriesDB.connect();
  });

  afterAll(async () => {
    await redisCache.disconnect();
    await timeSeriesDB.disconnect();
  });

  describe('Market-Level Detection (Polymarket API)', () => {
    it('should detect rapid odds shift using Polymarket API data', async () => {
      // Mock Polymarket API to return market data
      const mockMarketData = {
        conditionId: 'test-market-1',
        bestBid: 0.45,
        bestAsk: 0.55,
        lastPrice: 0.50,
        volume24h: 100000,
        liquidity: 50000,
      };

      vi.spyOn(polymarketAPI, 'getMarket').mockResolvedValue(mockMarketData);

      const trade: FilteredTrade = {
        marketId: 'test-market-1',
        marketName: 'Test Market',
        side: 'YES',
        price: 0.70, // 40% deviation from mid-price (0.50)
        sizeUSDC: 5000,
        timestamp: new Date(),
        walletAddress: '0x1234567890123456789012345678901234567890',
        orderBookLiquidity: 10000,
        marketCategory: 'crypto',
      };

      const anomalies = await anomalyDetector.analyze(trade);

      // Should detect RAPID_ODDS_SHIFT due to 40% deviation
      const rapidOddsAnomaly = anomalies.find(a => a.type === 'RAPID_ODDS_SHIFT');
      expect(rapidOddsAnomaly).toBeDefined();
      expect(rapidOddsAnomaly?.severity).toBe('HIGH');
      expect(rapidOddsAnomaly?.details.metrics).toHaveProperty('marketMidPrice');
      expect(rapidOddsAnomaly?.details.metrics).toHaveProperty('deviationPercent');
    });

    it('should fallback to local data when Polymarket API fails', async () => {
      // Mock API failure
      vi.spyOn(polymarketAPI, 'getMarket').mockResolvedValue(null);

      // Insert some price history
      const marketId = 'test-market-2';
      await timeSeriesDB.appendPricePoint(marketId, 0.50, 1000, new Date(Date.now() - 60000));
      await timeSeriesDB.appendPricePoint(marketId, 0.52, 1000, new Date(Date.now() - 30000));

      const trade: FilteredTrade = {
        marketId,
        marketName: 'Test Market 2',
        side: 'YES',
        price: 0.70, // 40% increase from 0.50
        sizeUSDC: 5000,
        timestamp: new Date(),
        walletAddress: '0x1234567890123456789012345678901234567890',
        orderBookLiquidity: 10000,
        marketCategory: 'crypto',
      };

      const anomalies = await anomalyDetector.analyze(trade);

      // Should still detect anomaly using fallback
      const rapidOddsAnomaly = anomalies.find(a => a.type === 'RAPID_ODDS_SHIFT');
      expect(rapidOddsAnomaly).toBeDefined();
      expect(rapidOddsAnomaly?.details.description).toContain('fallback');
    });
  });

  describe('Wallet-Level Behavioral Detection (Alchemy)', () => {
    it('should detect whale activity using behavioral Z-score', async () => {
      const walletAddress = '0x1234567890123456789012345678901234567890';

      // Mock wallet trade history: normally trades 100-500 USDC
      const mockHistory = {
        address: walletAddress,
        tradeSizes: [100, 200, 150, 300, 250, 180, 220, 280, 190, 240],
        tradeCount: 10,
        avgTradeSize: 211, // Average ~211 USDC
        stddevTradeSize: 60, // Stddev ~60 USDC
      };

      vi.spyOn(blockchainAnalyzer, 'getWalletTradeHistory').mockResolvedValue(mockHistory);

      const trade: FilteredTrade = {
        marketId: 'test-market-3',
        marketName: 'Test Market 3',
        side: 'YES',
        price: 0.60,
        sizeUSDC: 1000, // 13σ above wallet's average!
        timestamp: new Date(),
        walletAddress,
        orderBookLiquidity: 10000,
        marketCategory: 'crypto',
      };

      const anomalies = await anomalyDetector.analyze(trade);

      // Should detect WHALE_ACTIVITY with behavioral Z-score
      const whaleAnomaly = anomalies.find(a => a.type === 'WHALE_ACTIVITY');
      expect(whaleAnomaly).toBeDefined();
      expect(whaleAnomaly?.details.description).toContain('behavioral Z-score');
      expect(whaleAnomaly?.details.metrics).toHaveProperty('behavioralZScore');
      expect(whaleAnomaly?.details.metrics).toHaveProperty('walletAvgTradeSize');
      
      // Z-score should be very high
      const zScore = (whaleAnomaly?.details.metrics as any).behavioralZScore;
      expect(zScore).toBeGreaterThan(10);
    });

    it('should NOT alert for whale who trades normally large amounts', async () => {
      const walletAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

      // Mock whale wallet history: normally trades 5k-15k USDC
      const mockHistory = {
        address: walletAddress,
        tradeSizes: [5000, 8000, 12000, 7000, 10000, 9000, 11000, 6000, 13000, 8500],
        tradeCount: 10,
        avgTradeSize: 8950,
        stddevTradeSize: 2500,
      };

      vi.spyOn(blockchainAnalyzer, 'getWalletTradeHistory').mockResolvedValue(mockHistory);

      const trade: FilteredTrade = {
        marketId: 'test-market-4',
        marketName: 'Test Market 4',
        side: 'YES',
        price: 0.60,
        sizeUSDC: 10000, // Normal for this whale (Z-score ~0.4)
        timestamp: new Date(),
        walletAddress,
        orderBookLiquidity: 50000,
        marketCategory: 'crypto',
      };

      const anomalies = await anomalyDetector.analyze(trade);

      // Should NOT detect whale activity (within normal range)
      const whaleAnomaly = anomalies.find(a => a.type === 'WHALE_ACTIVITY');
      expect(whaleAnomaly).toBeUndefined();
    });

    it('should fallback to market-level detection when wallet history insufficient', async () => {
      const walletAddress = '0xnewwallet1234567890123456789012345678901';

      // Mock new wallet with insufficient history
      const mockHistory = {
        address: walletAddress,
        tradeSizes: [1000], // Only 1 trade
        tradeCount: 1,
        avgTradeSize: 1000,
        stddevTradeSize: 0,
      };

      vi.spyOn(blockchainAnalyzer, 'getWalletTradeHistory').mockResolvedValue(mockHistory);

      const trade: FilteredTrade = {
        marketId: 'test-market-5',
        marketName: 'Test Market 5',
        side: 'YES',
        price: 0.60,
        sizeUSDC: 15000, // Large trade
        timestamp: new Date(),
        walletAddress,
        orderBookLiquidity: 20000,
        marketCategory: 'crypto',
      };

      const anomalies = await anomalyDetector.analyze(trade);

      // Should detect using fallback method
      const whaleAnomaly = anomalies.find(a => a.type === 'WHALE_ACTIVITY');
      expect(whaleAnomaly).toBeDefined();
      expect(whaleAnomaly?.details.description).toContain('fallback');
    });
  });

  describe('Insider Trading with Behavioral Context', () => {
    it('should detect insider trading with both market and wallet signals', async () => {
      const walletAddress = '0xinsider1234567890123456789012345678901';

      // Mock new wallet with no history
      const mockHistory = {
        address: walletAddress,
        tradeSizes: [],
        tradeCount: 0,
        avgTradeSize: 0,
        stddevTradeSize: 0,
      };

      vi.spyOn(blockchainAnalyzer, 'getWalletTradeHistory').mockResolvedValue(mockHistory);

      // Mock wallet profile: very new wallet
      const mockProfile = {
        address: walletAddress,
        firstTransactionTimestamp: Date.now() - 2 * 3600 * 1000, // 2 hours old
        transactionCount: 1,
        ageHours: 2,
        isNew: true,
        riskScore: 80,
      };

      vi.spyOn(blockchainAnalyzer, 'analyzeWalletProfile').mockResolvedValue(mockProfile);

      // Mock Polymarket API showing price deviation
      const mockMarketData = {
        conditionId: 'test-market-6',
        bestBid: 0.40,
        bestAsk: 0.50,
        lastPrice: 0.45,
        volume24h: 50000,
        liquidity: 25000,
      };

      vi.spyOn(polymarketAPI, 'getMarket').mockResolvedValue(mockMarketData);

      const trade: FilteredTrade = {
        marketId: 'test-market-6',
        marketName: 'Niche Crypto Event',
        side: 'YES',
        price: 0.70, // 55% above mid-price!
        sizeUSDC: 8000, // Large trade for new wallet
        timestamp: new Date(),
        walletAddress,
        orderBookLiquidity: 15000,
        marketCategory: 'crypto', // Niche category
      };

      const anomalies = await anomalyDetector.analyze(trade);

      // Should detect both RAPID_ODDS_SHIFT and INSIDER_TRADING
      expect(anomalies.length).toBeGreaterThanOrEqual(2);
      
      const rapidOddsAnomaly = anomalies.find(a => a.type === 'RAPID_ODDS_SHIFT');
      expect(rapidOddsAnomaly).toBeDefined();
      
      const insiderAnomaly = anomalies.find(a => a.type === 'INSIDER_TRADING');
      expect(insiderAnomaly).toBeDefined();
      expect(insiderAnomaly?.severity).toBe('HIGH');
    });
  });
});
