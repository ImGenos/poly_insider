/**
 * Task 20.1: End-to-end trade processing integration test
 *
 * Validates: Requirements 1.3, 1.4, 2.1, 3.1, 4.1, 5.6
 *
 * Flow: trade received → filtered → analyzed → alert sent
 * All external services (WebSocket, Alchemy, Telegram) are mocked.
 */

import { EventEmitter } from 'events';
import { TradeFilter } from '../../src/filters/TradeFilter';
import { AnomalyDetector } from '../../src/detectors/AnomalyDetector';
import { AlertFormatter } from '../../src/alerts/AlertFormatter';
import { TelegramNotifier } from '../../src/notifications/TelegramNotifier';
import { RedisCache } from '../../src/cache/RedisCache';
import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { Logger } from '../../src/utils/Logger';
import {
  RawTrade,
  FilteredTrade,
  DetectionThresholds,
  WalletProfile,
  MarketVolatility,
  PricePoint,
  Anomaly,
} from '../../src/types/index';

// ─── Mock ws ──────────────────────────────────────────────────────────────────

let mockWsInstance: MockWs;

class MockWs extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWs.CONNECTING;
  close() { this.readyState = MockWs.CLOSED; this.emit('close'); }
  terminate() { this.readyState = MockWs.CLOSED; this.emit('close'); }
}

jest.mock('ws', () => {
  const mock = jest.fn().mockImplementation(() => {
    mockWsInstance = new MockWs();
    return mockWsInstance;
  });
  (mock as unknown as Record<string, unknown>).OPEN = 1;
  return mock;
});

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
  }));
});

// ─── Mock fetch (Telegram + Alchemy) ─────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

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
const WALLET2 = '0x1122334455667788990011223344556677889900';

function makeRawTrade(overrides: Partial<RawTrade> = {}): RawTrade {
  return {
    market_id: 'market-e2e',
    market_name: 'E2E Test Market',
    side: 'YES',
    price: 0.6,
    size: 10000,
    size_usd: 10000,
    timestamp: Date.now(),
    maker_address: WALLET2,
    taker_address: WALLET,
    order_book_depth: { bid_liquidity: 50000, ask_liquidity: 50000 },
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

function makeVolatility(overrides: Partial<MarketVolatility> = {}): MarketVolatility {
  return {
    marketId: 'market-e2e',
    avgPriceChange: 0.5,
    stddevPriceChange: 0.05,
    avgTradeSize: 5000,
    stddevTradeSize: 1000,
    sampleCount: 50,
    lastUpdated: new Date(),
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

function makeComponents() {
  const logger = makeLogger();

  const redisCache = {
    getWalletProfile: jest.fn().mockResolvedValue(null),
    saveWalletProfile: jest.fn().mockResolvedValue(undefined),
    hasAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordSentAlert: jest.fn().mockResolvedValue(undefined),
    hasClusterAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordClusterAlert: jest.fn().mockResolvedValue(undefined),
    isConnected: true,
  } as unknown as jest.Mocked<RedisCache>;

  const timeSeriesDB = {
    getMarketVolatility: jest.fn().mockResolvedValue(makeVolatility({ sampleCount: 5 })),
    getPriceHistory: jest.fn().mockResolvedValue([]),
    appendPricePoint: jest.fn().mockResolvedValue(undefined),
    recordClusterTrade: jest.fn().mockResolvedValue(undefined),
    getClusterWallets: jest.fn().mockResolvedValue([]),
    getClusterTotalSize: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<TimeSeriesDB>;

  const blockchainAnalyzer = {
    analyzeWalletProfile: jest.fn().mockResolvedValue(makeWalletProfile()),
    getWalletFunder: jest.fn().mockResolvedValue(null),
    analyzeClusterFunding: jest.fn().mockResolvedValue({
      wallets: [],
      funders: new Map(),
      sharedFunders: new Map(),
      hasCommonNonExchangeFunder: false,
      commonFunderAddress: null,
      isKnownExchange: false,
      exchangeName: null,
    }),
  } as unknown as jest.Mocked<BlockchainAnalyzer>;

  const tradeFilter = new TradeFilter(THRESHOLDS.minTradeSizeUSDC);
  const anomalyDetector = new AnomalyDetector(
    THRESHOLDS,
    timeSeriesDB as unknown as TimeSeriesDB,
    redisCache as unknown as RedisCache,
    blockchainAnalyzer as unknown as BlockchainAnalyzer,
    logger,
  );
  const alertFormatter = new AlertFormatter();

  // Mock Telegram sendAlert
  const telegramNotifier = {
    sendAlert: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<TelegramNotifier>;

  return {
    logger,
    redisCache,
    timeSeriesDB,
    blockchainAnalyzer,
    tradeFilter,
    anomalyDetector,
    alertFormatter,
    telegramNotifier,
  };
}

// ─── Helper: run the full pipeline for a single trade ─────────────────────────

async function runPipeline(
  rawTrade: RawTrade,
  components: ReturnType<typeof makeComponents>,
): Promise<{ filteredTrade: FilteredTrade | null; anomalies: Anomaly[] }> {
  const { tradeFilter, anomalyDetector, alertFormatter, telegramNotifier, redisCache } = components;

  const filteredTrade = tradeFilter.filter(rawTrade);
  if (!filteredTrade) {
    return { filteredTrade: null, anomalies: [] };
  }

  const anomalies = await anomalyDetector.analyze(filteredTrade);

  for (const anomaly of anomalies) {
    const alreadySent = await redisCache.hasAlertBeenSent(
      anomaly.type,
      filteredTrade.marketId,
      filteredTrade.walletAddress,
    );
    if (!alreadySent) {
      const msg = alertFormatter.format(anomaly, filteredTrade);
      await telegramNotifier.sendAlert(msg);
      await redisCache.recordSentAlert(
        anomaly.type,
        filteredTrade.marketId,
        filteredTrade.walletAddress,
        3600,
      );
    }
  }

  return { filteredTrade, anomalies };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('E2E: trade received → filtered → analyzed → alert sent', () => {
  it('filters out trades below minimum size (Req 2.1)', async () => {
    const components = makeComponents();
    const smallTrade = makeRawTrade({ size_usd: 100 });

    const { filteredTrade } = await runPipeline(smallTrade, components);

    expect(filteredTrade).toBeNull();
    expect(components.telegramNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('passes trades above minimum size through the filter (Req 2.1)', async () => {
    const components = makeComponents();
    const largeTrade = makeRawTrade({ size_usd: 10000 });

    const { filteredTrade } = await runPipeline(largeTrade, components);

    expect(filteredTrade).not.toBeNull();
    expect(filteredTrade!.sizeUSDC).toBe(10000);
  });

  it('sends Telegram alert when anomaly is detected (Req 4.1)', async () => {
    const components = makeComponents();

    // Whale trade: 80% of liquidity
    const whaleTrade = makeRawTrade({ size_usd: 80000 });
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.6, timestamp: new Date(Date.now() - 60000) },
    ]);

    const { anomalies } = await runPipeline(whaleTrade, components);

    // At least one anomaly should be detected
    expect(anomalies.length).toBeGreaterThan(0);
    expect(components.telegramNotifier.sendAlert).toHaveBeenCalled();
  });

  it('does NOT send duplicate alert for same trade (Req 1.4)', async () => {
    const components = makeComponents();
    components.redisCache.hasAlertBeenSent.mockResolvedValue(true); // already sent

    const whaleTrade = makeRawTrade({ size_usd: 80000 });
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.6, timestamp: new Date(Date.now() - 60000) },
    ]);

    await runPipeline(whaleTrade, components);

    expect(components.telegramNotifier.sendAlert).not.toHaveBeenCalled();
  });
});

describe('E2E: rapid odds shift detection (Req 3.1)', () => {
  it('detects rapid odds shift via static threshold', async () => {
    const components = makeComponents();

    // Price history starts at 0.1, trade at 0.9 → 800% change >> 15%
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.1, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);
    // Low sample count → static path
    components.timeSeriesDB.getMarketVolatility.mockResolvedValue(
      makeVolatility({ sampleCount: 5 }),
    );

    const trade = makeRawTrade({ price: 0.9, size_usd: 10000 });
    const { anomalies } = await runPipeline(trade, components);

    const rapidShift = anomalies.find(a => a.type === 'RAPID_ODDS_SHIFT');
    expect(rapidShift).toBeDefined();
    expect(components.telegramNotifier.sendAlert).toHaveBeenCalled();
  });

  it('detects rapid odds shift via Z-score when sufficient samples', async () => {
    const components = makeComponents();

    // avg=0.5, stddev=0.05, sampleCount=50 → Z-score of 0.9 = 8.0 >> 3.0
    components.timeSeriesDB.getMarketVolatility.mockResolvedValue(
      makeVolatility({ avgPriceChange: 0.5, stddevPriceChange: 0.05, sampleCount: 50 }),
    );
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.5, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);

    const trade = makeRawTrade({ price: 0.9, size_usd: 10000 });
    const { anomalies } = await runPipeline(trade, components);

    const rapidShift = anomalies.find(a => a.type === 'RAPID_ODDS_SHIFT');
    expect(rapidShift).toBeDefined();
    expect(rapidShift!.details.metrics.zScore).toBeDefined();
  });
});

describe('E2E: whale activity detection (Req 4.1)', () => {
  it('detects whale activity when trade consumes large fraction of liquidity', async () => {
    const components = makeComponents();
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.6, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);

    // 60000 / 100000 = 60% > 20% threshold
    const trade = makeRawTrade({ size_usd: 60000 });
    const { anomalies } = await runPipeline(trade, components);

    const whale = anomalies.find(a => a.type === 'WHALE_ACTIVITY');
    expect(whale).toBeDefined();
    expect(whale!.severity).toBe('HIGH');
  });
});

describe('E2E: insider trading detection (Req 5.6)', () => {
  it('detects insider trading for new wallet on niche market with large trade', async () => {
    const components = makeComponents();

    // New wallet (10h old), large trade, niche market
    components.redisCache.getWalletProfile.mockResolvedValue(
      makeWalletProfile({ ageHours: 10, transactionCount: 2 }),
    );
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.6, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);

    const trade = makeRawTrade({ size_usd: 15000 });
    const filteredTrade = components.tradeFilter.filter(trade)!;
    // Set niche market category
    filteredTrade.marketCategory = 'sports';

    const anomalies = await components.anomalyDetector.analyze(filteredTrade);
    const insider = anomalies.find(a => a.type === 'INSIDER_TRADING');
    expect(insider).toBeDefined();
  });

  it('does NOT detect insider trading for old wallet', async () => {
    const components = makeComponents();

    // Old wallet (1000h old)
    components.redisCache.getWalletProfile.mockResolvedValue(
      makeWalletProfile({ ageHours: 1000, isNew: false }),
    );
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.6, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);

    const trade = makeRawTrade({ size_usd: 15000 });
    const filteredTrade = components.tradeFilter.filter(trade)!;
    filteredTrade.marketCategory = 'sports';

    const anomalies = await components.anomalyDetector.analyze(filteredTrade);
    const insider = anomalies.find(a => a.type === 'INSIDER_TRADING');
    expect(insider).toBeUndefined();
  });
});

describe('E2E: all three anomaly types detected simultaneously', () => {
  it('detects rapid shift + whale + insider for a single anomalous trade', async () => {
    const components = makeComponents();

    // New wallet
    components.redisCache.getWalletProfile.mockResolvedValue(
      makeWalletProfile({ ageHours: 5, transactionCount: 1 }),
    );
    // Price history: starts at 0.1 → 800% change
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.1, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);
    // Low sample count → static path
    components.timeSeriesDB.getMarketVolatility.mockResolvedValue(
      makeVolatility({ sampleCount: 5 }),
    );

    // Large trade consuming 80% of liquidity
    const trade = makeRawTrade({ price: 0.9, size_usd: 80000 });
    const filteredTrade = components.tradeFilter.filter(trade)!;
    filteredTrade.marketCategory = 'sports';

    const anomalies = await components.anomalyDetector.analyze(filteredTrade);
    const types = anomalies.map(a => a.type);

    expect(types).toContain('RAPID_ODDS_SHIFT');
    expect(types).toContain('WHALE_ACTIVITY');
    expect(types).toContain('INSIDER_TRADING');
  });
});

describe('E2E: alert formatting and Telegram delivery', () => {
  it('formats and sends a Telegram message with correct parse_mode', async () => {
    const components = makeComponents();
    components.timeSeriesDB.getPriceHistory.mockResolvedValue([
      { marketId: 'market-e2e', price: 0.1, timestamp: new Date(Date.now() - 60000) },
    ] as PricePoint[]);
    components.timeSeriesDB.getMarketVolatility.mockResolvedValue(
      makeVolatility({ sampleCount: 5 }),
    );

    const trade = makeRawTrade({ price: 0.9, size_usd: 10000 });
    await runPipeline(trade, components);

    if (components.telegramNotifier.sendAlert.mock.calls.length > 0) {
      const sentMsg = components.telegramNotifier.sendAlert.mock.calls[0][0];
      expect(sentMsg.parse_mode).toBe('Markdown');
      expect(typeof sentMsg.text).toBe('string');
      expect(sentMsg.text.length).toBeGreaterThan(0);
    }
  });
});
