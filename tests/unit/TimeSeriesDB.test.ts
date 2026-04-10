import { TimeSeriesDB } from '../../src/db/TimeSeriesDB';
import { FilteredTrade } from '../../src/types/index';
import { Logger } from '../../src/utils/Logger';

// ─── Mock pg ──────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      query: mockQuery,
      end: mockEnd,
    })),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

function makeTrade(overrides: Partial<FilteredTrade> = {}): FilteredTrade {
  return {
    marketId: 'market-1',
    marketName: 'Test Market',
    side: 'YES',
    price: 0.6,
    sizeUSDC: 10000,
    timestamp: new Date('2024-01-01T12:00:00Z'),
    walletAddress: '0xabc123',
    orderBookLiquidity: 50000,
    ...overrides,
  };
}

async function makeConnectedDB(): Promise<TimeSeriesDB> {
  // initSchema runs on connect — mock the client used inside initSchema
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockResolvedValue({ rows: [] });

  const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());
  await db.connect();
  // Reset call counts but keep the default implementation so pool.query still works
  mockQuery.mockClear();
  mockConnect.mockClear();
  mockRelease.mockClear();
  return db;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── appendPricePoint / getPriceHistory round-trip ───────────────────────────

describe('TimeSeriesDB — appendPricePoint and getPriceHistory', () => {
  it('inserts a price point with correct parameters', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [] });
    const ts = new Date('2024-01-01T12:00:00Z');

    await db.appendPricePoint('market-1', 0.65, ts);

    expect(mockQuery).toHaveBeenCalledWith(
      'INSERT INTO price_history (time, market_id, price) VALUES ($1, $2, $3)',
      [ts, 'market-1', 0.65],
    );
  });

  it('returns price points within the requested time window', async () => {
    const db = await makeConnectedDB();
    const since = new Date('2024-01-01T11:00:00Z');
    const rows = [
      { time: new Date('2024-01-01T11:30:00Z'), market_id: 'market-1', price: 0.55 },
      { time: new Date('2024-01-01T12:00:00Z'), market_id: 'market-1', price: 0.65 },
    ];
    mockQuery.mockResolvedValue({ rows });

    const result = await db.getPriceHistory('market-1', since);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ marketId: 'market-1', price: 0.55, timestamp: rows[0].time });
    expect(result[1]).toEqual({ marketId: 'market-1', price: 0.65, timestamp: rows[1].time });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
      ['market-1', since],
    );
  });

  it('returns empty array when no price history exists', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await db.getPriceHistory('unknown-market', new Date());
    expect(result).toEqual([]);
  });

  it('returns empty array when DB unavailable (pool is null)', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());
    // Never call connect() — pool stays null

    const result = await db.getPriceHistory('market-1', new Date());
    expect(result).toEqual([]);
  });

  it('returns empty array and logs error on query failure', async () => {
    const logger = makeLogger();
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // initSchema
    const db = new TimeSeriesDB('postgresql://localhost/test', logger);
    await db.connect();

    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const result = await db.getPriceHistory('market-1', new Date());

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─── getMarketVolatility ──────────────────────────────────────────────────────

describe('TimeSeriesDB — getMarketVolatility', () => {
  it('returns correct mean and stddev from continuous aggregate', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({
      rows: [{ avg_price: '0.62', stddev_price: '0.05', trade_count: '45' }],
    });

    const result = await db.getMarketVolatility('market-1', 60);

    expect(result.marketId).toBe('market-1');
    expect(result.avgPriceChange).toBeCloseTo(0.62);
    expect(result.stddevPriceChange).toBeCloseTo(0.05);
    expect(result.sampleCount).toBe(45);
  });

  it('returns zero baseline when no rows in aggregate', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await db.getMarketVolatility('new-market', 60);

    expect(result.sampleCount).toBe(0);
    expect(result.avgPriceChange).toBe(0);
    expect(result.stddevPriceChange).toBe(0);
  });

  it('treats null stddev_price as 0', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({
      rows: [{ avg_price: '0.5', stddev_price: null, trade_count: '1' }],
    });

    const result = await db.getMarketVolatility('market-1', 60);
    expect(result.stddevPriceChange).toBe(0);
  });

  it('returns zero baseline when DB unavailable', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());

    const result = await db.getMarketVolatility('market-1', 60);
    expect(result.sampleCount).toBe(0);
  });

  it('returns zero baseline and logs error on query failure', async () => {
    const logger = makeLogger();
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // initSchema
    const db = new TimeSeriesDB('postgresql://localhost/test', logger);
    await db.connect();

    mockQuery.mockRejectedValueOnce(new Error('timeout'));
    const result = await db.getMarketVolatility('market-1', 60);

    expect(result.sampleCount).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─── getClusterWallets ────────────────────────────────────────────────────────

describe('TimeSeriesDB — getClusterWallets returns distinct wallets only', () => {
  it('returns distinct wallet addresses from query', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({
      rows: [
        { wallet_address: '0xaaa' },
        { wallet_address: '0xbbb' },
        { wallet_address: '0xccc' },
      ],
    });
    const since = new Date('2024-01-01T11:50:00Z');

    const wallets = await db.getClusterWallets('market-1', 'YES', since);

    expect(wallets).toEqual(['0xaaa', '0xbbb', '0xccc']);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DISTINCT'),
      ['market-1', 'YES', since],
    );
  });

  it('returns empty array when no wallets found', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [] });

    const wallets = await db.getClusterWallets('market-1', 'YES', new Date());
    expect(wallets).toEqual([]);
  });

  it('returns empty array when DB unavailable', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());

    const wallets = await db.getClusterWallets('market-1', 'YES', new Date());
    expect(wallets).toEqual([]);
  });

  it('returns empty array and logs error on query failure', async () => {
    const logger = makeLogger();
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // initSchema
    const db = new TimeSeriesDB('postgresql://localhost/test', logger);
    await db.connect();

    mockQuery.mockRejectedValueOnce(new Error('db error'));
    const wallets = await db.getClusterWallets('market-1', 'YES', new Date());

    expect(wallets).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─── recordClusterTrade ───────────────────────────────────────────────────────

describe('TimeSeriesDB — recordClusterTrade', () => {
  it('inserts trade into cluster_trades with correct parameters', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [] });
    const trade = makeTrade();

    await db.recordClusterTrade(trade);

    expect(mockQuery).toHaveBeenCalledWith(
      'INSERT INTO cluster_trades (time, market_id, side, wallet_address, size_usd) VALUES ($1, $2, $3, $4, $5)',
      [trade.timestamp, trade.marketId, trade.side, trade.walletAddress, trade.sizeUSDC],
    );
  });

  it('is a no-op when DB unavailable', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());

    await expect(db.recordClusterTrade(makeTrade())).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─── getClusterTotalSize ──────────────────────────────────────────────────────

describe('TimeSeriesDB — getClusterTotalSize', () => {
  it('returns summed size_usd', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [{ total: '75000.5' }] });

    const total = await db.getClusterTotalSize('market-1', 'YES', new Date());
    expect(total).toBeCloseTo(75000.5);
  });

  it('returns 0 when SUM is null (no rows)', async () => {
    const db = await makeConnectedDB();
    mockQuery.mockResolvedValue({ rows: [{ total: null }] });

    const total = await db.getClusterTotalSize('market-1', 'YES', new Date());
    expect(total).toBe(0);
  });

  it('returns 0 when DB unavailable', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());

    const total = await db.getClusterTotalSize('market-1', 'YES', new Date());
    expect(total).toBe(0);
  });
});

// ─── Graceful null/empty on DB unavailability ─────────────────────────────────

describe('TimeSeriesDB — graceful degradation when pool is null', () => {
  it('appendPricePoint resolves without throwing', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());
    await expect(db.appendPricePoint('m', 0.5, new Date())).resolves.toBeUndefined();
  });

  it('getMarketVolatility returns zero-baseline object', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());
    const v = await db.getMarketVolatility('m', 60);
    expect(v.sampleCount).toBe(0);
    expect(v.marketId).toBe('m');
  });

  it('recordClusterTrade resolves without throwing', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());
    await expect(db.recordClusterTrade(makeTrade())).resolves.toBeUndefined();
  });

  it('getClusterTotalSize returns 0', async () => {
    const db = new TimeSeriesDB('postgresql://localhost/test', makeLogger());
    expect(await db.getClusterTotalSize('m', 'YES', new Date())).toBe(0);
  });
});
