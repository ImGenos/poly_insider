import { RedisCache } from '../../src/cache/RedisCache';
import { WalletProfile } from '../../src/types/index';
import { Logger } from '../../src/utils/Logger';

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

const mockOn = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockQuit = jest.fn().mockResolvedValue(undefined);
const mockHset = jest.fn();
const mockHgetall = jest.fn();
const mockHget = jest.fn();
const mockSetex = jest.fn();
const mockGet = jest.fn();
const mockXadd = jest.fn();
const mockXreadgroup = jest.fn();
const mockXack = jest.fn();
const mockXlen = jest.fn();
const mockXgroup = jest.fn();
const mockExpire = jest.fn().mockResolvedValue(1);

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: mockOn,
    connect: mockConnect,
    quit: mockQuit,
    hset: mockHset,
    hgetall: mockHgetall,
    hget: mockHget,
    setex: mockSetex,
    get: mockGet,
    xadd: mockXadd,
    xreadgroup: mockXreadgroup,
    xack: mockXack,
    xlen: mockXlen,
    xgroup: mockXgroup,
    expire: mockExpire,
  }));
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

async function makeConnectedCache(logger?: Logger): Promise<RedisCache> {
  const cache = new RedisCache('redis://localhost:6379', logger ?? makeLogger());
  await cache.connect();
  // Simulate the 'connect' event firing so isConnected = true
  cache.isConnected = true;
  return cache;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
});

// ─── Wallet Profile ───────────────────────────────────────────────────────────

describe('RedisCache — wallet profile save/retrieve round-trip', () => {
  const profile: WalletProfile = {
    address: '0xabc123',
    firstTransactionTimestamp: 1700000000,
    transactionCount: 42,
    ageHours: 72,
    isNew: false,
    riskScore: 25,
  };

  it('saves a wallet profile via HSET', async () => {
    mockHset.mockResolvedValue(1);
    const cache = await makeConnectedCache();

    await cache.saveWalletProfile(profile);

    expect(mockHset).toHaveBeenCalledWith(
      'wallet:0xabc123',
      'first_tx_timestamp', '1700000000',
      'tx_count', '42',
      'age_hours', '72',
      'is_new', 'false',
      'risk_score', '25',
    );
  });

  it('retrieves a wallet profile via HGETALL and maps fields correctly', async () => {
    mockHgetall.mockResolvedValue({
      first_tx_timestamp: '1700000000',
      tx_count: '42',
      age_hours: '72',
      is_new: 'false',
      risk_score: '25',
    });
    const cache = await makeConnectedCache();

    const result = await cache.getWalletProfile('0xabc123');

    expect(result).toEqual(profile);
    expect(mockHgetall).toHaveBeenCalledWith('wallet:0xabc123');
  });

  it('returns null when HGETALL returns empty object', async () => {
    mockHgetall.mockResolvedValue({});
    const cache = await makeConnectedCache();

    const result = await cache.getWalletProfile('0xunknown');
    expect(result).toBeNull();
  });

  it('handles null firstTransactionTimestamp and ageHours', async () => {
    mockHgetall.mockResolvedValue({
      first_tx_timestamp: '',
      tx_count: '0',
      age_hours: '',
      is_new: 'true',
      risk_score: '0',
    });
    const cache = await makeConnectedCache();

    const result = await cache.getWalletProfile('0xnew');
    expect(result?.firstTransactionTimestamp).toBeNull();
    expect(result?.ageHours).toBeNull();
    expect(result?.isNew).toBe(true);
  });

  it('round-trips: saved values are retrievable', async () => {
    // Capture what was passed to hset and replay it via hgetall
    let storedFields: Record<string, string> = {};
    mockHset.mockImplementation((_key: string, ...args: string[]) => {
      for (let i = 0; i < args.length - 1; i += 2) {
        storedFields[args[i]] = args[i + 1];
      }
      return Promise.resolve(1);
    });
    mockHgetall.mockImplementation(() => Promise.resolve({ ...storedFields }));

    const cache = await makeConnectedCache();
    await cache.saveWalletProfile(profile);
    const retrieved = await cache.getWalletProfile(profile.address);

    expect(retrieved).toEqual(profile);
  });
});

// ─── Alert Deduplication ──────────────────────────────────────────────────────

describe('RedisCache — alert deduplication', () => {
  it('returns false before an alert is recorded', async () => {
    mockGet.mockResolvedValue(null);
    const cache = await makeConnectedCache();

    const result = await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet');
    expect(result).toBe(false);
  });

  it('returns true after an alert is recorded', async () => {
    mockSetex.mockResolvedValue('OK');
    mockGet.mockResolvedValue('1');
    const cache = await makeConnectedCache();

    await cache.recordSentAlert('WHALE', 'market-1', '0xwallet', 3600);
    const result = await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet');

    expect(result).toBe(true);
    expect(mockSetex).toHaveBeenCalledWith('alert:WHALE:market-1:0xwallet', 3600, '1');
  });

  it('returns false after TTL expiry (mock returns null)', async () => {
    mockSetex.mockResolvedValue('OK');
    // First call: key exists; second call: TTL expired, key gone
    mockGet
      .mockResolvedValueOnce('1')   // right after recording
      .mockResolvedValueOnce(null); // after TTL expiry

    const cache = await makeConnectedCache();
    await cache.recordSentAlert('WHALE', 'market-1', '0xwallet', 1);

    const beforeExpiry = await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet');
    expect(beforeExpiry).toBe(true);

    const afterExpiry = await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet');
    expect(afterExpiry).toBe(false);
  });

  it('uses the correct Redis key format', async () => {
    mockGet.mockResolvedValue(null);
    const cache = await makeConnectedCache();

    await cache.hasAlertBeenSent('INSIDER', 'mkt-42', '0xabc');
    expect(mockGet).toHaveBeenCalledWith('alert:INSIDER:mkt-42:0xabc');
  });
});

// ─── Stream Push / Read Round-Trip ───────────────────────────────────────────

describe('RedisCache — stream push and read round-trip', () => {
  it('pushes to stream with XADD and returns message id', async () => {
    mockXadd.mockResolvedValue('1700000000000-0');
    const cache = await makeConnectedCache();

    const id = await cache.pushToStream('trades:stream', { event: 'trade', size: '5000' });

    expect(id).toBe('1700000000000-0');
    expect(mockXadd).toHaveBeenCalledWith(
      'trades:stream', 'MAXLEN', '~', '100000', '*',
      'event', 'trade', 'size', '5000',
    );
  });

  it('reads messages from stream via XREADGROUP', async () => {
    mockXreadgroup.mockResolvedValue([
      ['trades:stream', [
        ['1700000000000-0', ['event', 'trade', 'size', '5000']],
        ['1700000000001-0', ['event', 'trade', 'size', '8000']],
      ]],
    ]);
    const cache = await makeConnectedCache();

    const messages = await cache.readFromStream('trades:stream', 'grp', 'consumer-1', 10);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ id: '1700000000000-0', fields: { event: 'trade', size: '5000' } });
    expect(messages[1]).toEqual({ id: '1700000000001-0', fields: { event: 'trade', size: '8000' } });
    expect(mockXreadgroup).toHaveBeenCalledWith(
      'GROUP', 'grp', 'consumer-1',
      'COUNT', 10,
      'BLOCK', 100,
      'STREAMS', 'trades:stream', '>',
    );
  });

  it('returns empty array when XREADGROUP returns null (no messages)', async () => {
    mockXreadgroup.mockResolvedValue(null);
    const cache = await makeConnectedCache();

    const messages = await cache.readFromStream('trades:stream', 'grp', 'consumer-1', 10);
    expect(messages).toEqual([]);
  });

  it('round-trips: pushed fields are readable', async () => {
    const fields = { type: 'WHALE', market: 'mkt-1', wallet: '0xabc' };
    mockXadd.mockResolvedValue('1700000000000-0');
    mockXreadgroup.mockResolvedValue([
      ['trades:stream', [
        ['1700000000000-0', ['type', 'WHALE', 'market', 'mkt-1', 'wallet', '0xabc']],
      ]],
    ]);

    const cache = await makeConnectedCache();
    await cache.pushToStream('trades:stream', fields);
    const messages = await cache.readFromStream('trades:stream', 'grp', 'consumer-1', 1);

    expect(messages[0].fields).toEqual(fields);
  });
});

// ─── XACK ─────────────────────────────────────────────────────────────────────

describe('RedisCache — XACK removes message from pending', () => {
  it('calls XACK with correct stream, group, and message id', async () => {
    mockXack.mockResolvedValue(1);
    const cache = await makeConnectedCache();

    await cache.acknowledgeMessage('trades:stream', 'grp', '1700000000000-0');

    expect(mockXack).toHaveBeenCalledWith('trades:stream', 'grp', '1700000000000-0');
  });

  it('does not throw when called on a connected cache', async () => {
    mockXack.mockResolvedValue(1);
    const cache = await makeConnectedCache();

    await expect(
      cache.acknowledgeMessage('trades:stream', 'grp', '1700000000000-0'),
    ).resolves.toBeUndefined();
  });
});

// ─── In-Memory Fallback ───────────────────────────────────────────────────────

describe('RedisCache — in-memory fallback when Redis unavailable', () => {
  it('hasAlertBeenSent returns false before recording (no Redis)', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    // Do NOT connect — client is null, isConnected is false

    const result = await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet');
    expect(result).toBe(false);
  });

  it('recordSentAlert stores in dedupMap and hasAlertBeenSent returns true (no Redis)', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    await cache.recordSentAlert('WHALE', 'market-1', '0xwallet', 3600);
    const result = await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet');

    expect(result).toBe(true);
  });

  it('different alert keys are independent in dedupMap', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    await cache.recordSentAlert('WHALE', 'market-1', '0xwallet', 3600);

    expect(await cache.hasAlertBeenSent('WHALE', 'market-1', '0xwallet')).toBe(true);
    expect(await cache.hasAlertBeenSent('INSIDER', 'market-1', '0xwallet')).toBe(false);
    expect(await cache.hasAlertBeenSent('WHALE', 'market-2', '0xwallet')).toBe(false);
  });

  it('cluster alert dedup also falls back to in-memory map', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());

    expect(await cache.hasClusterAlertBeenSent('market-1', 'YES')).toBe(false);
    await cache.recordClusterAlert('market-1', 'YES', 600);
    expect(await cache.hasClusterAlertBeenSent('market-1', 'YES')).toBe(true);
    expect(await cache.hasClusterAlertBeenSent('market-1', 'NO')).toBe(false);
  });

  it('getWalletProfile returns null when Redis unavailable', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    const result = await cache.getWalletProfile('0xabc');
    expect(result).toBeNull();
  });

  it('saveWalletProfile is a no-op when Redis unavailable', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    const profile: WalletProfile = {
      address: '0xabc',
      firstTransactionTimestamp: null,
      transactionCount: 0,
      ageHours: null,
      isNew: true,
      riskScore: 0,
    };
    await expect(cache.saveWalletProfile(profile)).resolves.toBeUndefined();
    expect(mockHset).not.toHaveBeenCalled();
  });

  it('readFromStream returns empty array when Redis unavailable', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    const messages = await cache.readFromStream('trades:stream', 'grp', 'consumer-1', 10);
    expect(messages).toEqual([]);
  });

  it('pushToStream throws when Redis unavailable', async () => {
    const cache = new RedisCache('redis://localhost:6379', makeLogger());
    await expect(
      cache.pushToStream('trades:stream', { key: 'val' }),
    ).rejects.toThrow('Redis not connected');
  });
});
