/**
 * Detector simulation test — exercises all 5 detection features
 * with crafted trades that should trigger each one,
 * and sends a real Telegram alert for each.
 *
 * Run: node test-detectors.js
 */
require('dotenv').config();

const { ConfigManager }      = require('./dist/config/ConfigManager');
const { RedisCache }         = require('./dist/cache/RedisCache');
const { TimeSeriesDB }       = require('./dist/db/TimeSeriesDB');
const { BlockchainAnalyzer } = require('./dist/blockchain/BlockchainAnalyzer');
const { PolymarketAPI }      = require('./dist/blockchain/PolymarketAPI');
const { AnomalyDetector }    = require('./dist/detectors/AnomalyDetector');
const { ClusterDetector }    = require('./dist/detectors/ClusterDetector');
const { SmartMoneyDetector } = require('./dist/detectors/SmartMoneyDetector');
const { AlertFormatter }     = require('./dist/alerts/AlertFormatter');
const { TelegramNotifier }   = require('./dist/notifications/TelegramNotifier');
const { Logger }             = require('./dist/utils/Logger');

const logger    = new Logger('info');
const config    = new ConfigManager();
const formatter = new AlertFormatter();
const telegram  = new TelegramNotifier(config.getTelegramConfig(), logger);

// ─── Shared mock infrastructure ───────────────────────────────────────────────

/** Minimal RedisCache stub — no real Redis needed */
const mockRedis = {
  isConnected: true,
  get: async () => null,
  set: async () => {},
  getWalletProfile: async () => null,
  saveWalletProfile: async () => {},
  getWalletFunder: async () => null,
  cacheWalletFunder: async () => {},
  hasAlertBeenSent: async () => false,
  recordSentAlert: async () => {},
  hasClusterAlertBeenSent: async () => false,
  recordClusterAlert: async () => {},
};

/** Minimal TimeSeriesDB stub */
const mockDB = {
  getMarketVolatility: async (marketId) => ({
    marketId,
    avgPrice: 0.50,
    stddevPrice: 0.05,
    avgTradeSize: 500,
    stddevTradeSize: 200,
    sampleCount: 50,
  }),
  getPriceHistory: async (marketId) => [
    { marketId, price: 0.50, timestamp: new Date(Date.now() - 4 * 60 * 1000) },
    { marketId, price: 0.51, timestamp: new Date(Date.now() - 2 * 60 * 1000) },
  ],
  recordClusterTrade: async () => {},
  getClusterWallets: async () => [],
  getClusterTotalSize: async () => 0,
  recordSmartMoneyTrade: async () => {},
  appendPricePoint: async () => {},
};

const thresholds = config.getThresholds();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTrade(overrides = {}) {
  return {
    marketId:          'test-market-001',
    marketName:        'Will candidate X win the 2026 election?',
    outcome:           'YES',
    side:              'YES',
    price:             0.55,
    sizeUSDC:          6000,
    timestamp:         new Date(),
    walletAddress:     '0xabc123def456abc123def456abc123def456abc1',
    orderBookLiquidity: 50000,
    marketCategory:    'politics',
    ...overrides,
  };
}

function pass(name)  { console.log(`  ✅  ${name}`); }
function fail(name, reason) { console.log(`  ❌  ${name}: ${reason}`); }
function section(name) { console.log(`\n${'─'.repeat(60)}\n  ${name}\n${'─'.repeat(60)}`); }

async function sendAlert(msg) {
  try {
    await telegram.sendAlert(msg);
    console.log('  📨 Telegram alert sent');
  } catch (err) {
    console.log(`  ⚠️  Telegram send failed: ${err.message}`);
  }
}

// ─── 1. Rapid Odds Shift ──────────────────────────────────────────────────────

async function testRapidOddsShift() {
  section('1. Rapid Odds Shift Detection');

  // Mock DB returns price history at 0.50; trade price is 0.80 → 60% shift >> 15% threshold
  const dbWithHistory = {
    ...mockDB,
    getPriceHistory: async () => [
      { marketId: 'test-market-001', price: 0.50, timestamp: new Date(Date.now() - 4 * 60 * 1000) },
    ],
    getMarketVolatility: async () => ({
      marketId: 'test-market-001',
      avgPrice: 0.50, stddevPrice: 0.02,
      avgTradeSize: 500, stddevTradeSize: 200,
      sampleCount: 50,
    }),
  };

  const blockchainAnalyzer = new BlockchainAnalyzer(
    config.getAlchemyApiKey(), '', [], logger
  );
  const detector = new AnomalyDetector(
    thresholds, dbWithHistory, mockRedis, blockchainAnalyzer, null, logger
  );

  const trade = makeTrade({ price: 0.80 }); // 60% shift from 0.50 baseline
  const priceHistory = await dbWithHistory.getPriceHistory(trade.marketId);
  const volatility   = await dbWithHistory.getMarketVolatility(trade.marketId);

  const result = await detector.detectRapidOddsShift(
    trade, priceHistory, volatility,
    thresholds.rapidOddsShiftPercent,  // 15%
    thresholds.zScoreThreshold,        // 3.0
  );

  if (result && result.type === 'RAPID_ODDS_SHIFT') {
    pass(`Detected — severity: ${result.severity}, confidence: ${result.confidence.toFixed(2)}`);
    console.log(`     ${result.details.description}`);
    const msg = formatter.format(result, trade);
    await sendAlert(msg);
  } else {
    fail('Rapid Odds Shift', 'no anomaly returned');
  }
}

// ─── 2. Whale Activity ────────────────────────────────────────────────────────

async function testWhaleActivity() {
  section('2. Whale Activity Detection');

  // Wallet history: avg $200, stddev $50 → current trade $8000 = huge Z-score
  const blockchainAnalyzer = {
    getWalletTradeHistory: async () => ({
      address: '0xwhale',
      tradeSizes: [150, 200, 180, 220, 190, 210, 170, 200, 195, 205],
      tradeCount: 10,
      avgTradeSize: 192,
      stddevTradeSize: 20,
      fetchFailed: false,
    }),
    analyzeWalletProfile: async () => ({ ageHours: 8760, transactionCount: 50, isNew: false, riskScore: 10 }),
  };

  const detector = new AnomalyDetector(
    thresholds, mockDB, mockRedis, blockchainAnalyzer, null, logger
  );

  const trade = makeTrade({ sizeUSDC: 8000, walletAddress: '0xwhale' });
  const volatility = await mockDB.getMarketVolatility(trade.marketId);

  const result = await detector.detectWhaleActivity(
    trade, volatility,
    thresholds.whaleActivityPercent,
    thresholds.zScoreThreshold,
  );

  if (result && result.type === 'WHALE_ACTIVITY') {
    pass(`Detected — severity: ${result.severity}, confidence: ${result.confidence.toFixed(2)}`);
    console.log(`     ${result.details.description}`);
    const msg = formatter.format(result, trade);
    await sendAlert(msg);
  } else {
    fail('Whale Activity', 'no anomaly returned');
  }
}

// ─── 3. Insider Trading ───────────────────────────────────────────────────────

async function testInsiderTrading() {
  section('3. Insider Trading Detection');

  // New wallet (2h old), large trade ($15k), niche market (politics)
  const blockchainAnalyzer = {
    analyzeWalletProfile: async () => ({
      address: '0xinsider',
      firstTransactionTimestamp: Date.now() - 2 * 3600 * 1000,
      transactionCount: 2,
      ageHours: 2,
      isNew: true,
      riskScore: 80,
    }),
    getWalletTradeHistory: async () => ({ tradeSizes: [], tradeCount: 0, avgTradeSize: 0, stddevTradeSize: 0, fetchFailed: true }),
  };

  const detector = new AnomalyDetector(
    thresholds, mockDB, mockRedis, blockchainAnalyzer, null, logger
  );

  const trade = makeTrade({
    sizeUSDC:       15000,
    walletAddress:  '0xinsider',
    marketCategory: 'crypto',  // matches default nicheMarketCategories
  });

  const result = await detector.detectInsiderTrading(trade);

  if (result && result.type === 'INSIDER_TRADING') {
    pass(`Detected — severity: ${result.severity}, confidence: ${result.confidence.toFixed(2)}`);
    console.log(`     ${result.details.description}`);
    const msg = formatter.format(result, trade);
    await sendAlert(msg);
  } else {
    fail('Insider Trading', `no anomaly returned — check nicheMarketCategories: ${JSON.stringify(thresholds.nicheMarketCategories)}`);
  }
}

// ─── 4. Coordinated Cluster ───────────────────────────────────────────────────

async function testClusterDetection() {
  section('4. Coordinated Cluster Detection');

  // DB returns 5 distinct wallets already in the window → HIGH severity
  const dbWithCluster = {
    ...mockDB,
    recordClusterTrade: async () => {},
    getClusterWallets: async () => [
      '0xwallet1', '0xwallet2', '0xwallet3', '0xwallet4', '0xwallet5',
    ],
    getClusterTotalSize: async () => 35000,
  };

  const blockchainAnalyzer = {
    analyzeClusterFunding: async (wallets) => ({
      wallets,
      funders: new Map(),
      sharedFunders: new Map(),
      hasCommonNonExchangeFunder: false,
      commonFunderAddress: null,
      isKnownExchange: false,
      exchangeName: null,
    }),
  };

  const detector = new ClusterDetector(
    thresholds, dbWithCluster, mockRedis, blockchainAnalyzer, logger, 600
  );

  const trade = makeTrade({ sizeUSDC: 7000 });
  const result = await detector.detectCluster(trade);

  if (result && result.type === 'COORDINATED_MOVE') {
    pass(`Detected — severity: ${result.severity}, wallets: ${result.wallets.length}, total: $${result.totalSizeUSDC}`);
    const msg = formatter.formatClusterMessage(result);
    await sendAlert(msg);
  } else {
    fail('Cluster Detection', 'no anomaly returned');
  }
}

// ─── 5. Smart Money ───────────────────────────────────────────────────────────

async function testSmartMoney() {
  section('5. Smart Money Detection');

  // High-volume, regular trader making a large bet on a non-sports market
  const mockRedisWithNoCache = { ...mockRedis, get: async () => null };

  const detector = new SmartMoneyDetector(
    {
      minTradeSizeUSDC:      5000,
      confidenceThreshold:   80,
      walletProfileTTL:      86400,
    },
    mockDB,
    mockRedisWithNoCache,
    null,
    logger,
  );

  // Inject a mock getPolymarketHistory by patching the private method
  detector._testOverrideHistory = [
    ...Array(20).fill(null).map((_, i) => ({
      hash: `0xhash${i}`,
      timestamp: Date.now() - i * 24 * 3600 * 1000,
      value: 600 + (i % 3) * 5,  // very regular: ~600-610 USDC, total ~12k in 30d
      asset: 'USDC',
    })),
  ];

  // Monkey-patch getPolymarketHistory to return our controlled history
  const original = detector['getPolymarketHistory'].bind(detector);
  detector['getPolymarketHistory'] = async () => detector._testOverrideHistory;

  const trade = makeTrade({
    sizeUSDC:       6000,   // above minTradeSizeUSDC=5000, and ~10x their avg of ~605
    walletAddress:  '0xsmartmoney',
    marketName:     'Will the Fed cut rates in 2026?',
    marketCategory: 'economics',
  });

  const result = await detector.detect(trade);

  // Debug: compute score manually to see what's happening
  const history = detector._testOverrideHistory;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  const recentVolume = history.filter(t => t.timestamp > thirtyDaysAgo).reduce((s, t) => s + t.value, 0);
  const avg = history.reduce((s, t) => s + t.value, 0) / history.length;
  const betSizeRatio = trade.sizeUSDC / avg;
  console.log(`     Debug — recentVolume: $${recentVolume.toFixed(0)}, avg: $${avg.toFixed(0)}, betSizeRatio: ${betSizeRatio.toFixed(2)}x`);

  if (result) {
    pass(`Detected — severity: ${result.severity}, score: ${result.confidenceIndex.score}`);
    console.log(`     Volume score: ${result.confidenceIndex.metrics.volumeScore.toFixed(1)}, ` +
      `BetSize score: ${result.confidenceIndex.metrics.betSizeScore.toFixed(1)}, ` +
      `Regularity score: ${result.confidenceIndex.metrics.regularityScore.toFixed(1)}`);
    const msg = formatter.formatSmartMoneyMessage(result);
    await sendAlert(msg);
  } else {
    fail('Smart Money', 'no alert returned — score may be below threshold (80)');
  }
}

// ─── Run all ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔬 Detector Simulation Test\n');
  try {
    await testRapidOddsShift();
    await testWhaleActivity();
    await testInsiderTrading();
    await testClusterDetection();
    await testSmartMoney();
    console.log('\n✅ All simulations complete\n');
  } catch (err) {
    console.error('\n💥 Unexpected error:', err);
  }
  process.exit(0);
}

main();
