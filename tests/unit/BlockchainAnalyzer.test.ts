import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { RedisCache } from '../../src/cache/RedisCache';
import { Logger } from '../../src/utils/Logger';
import { WalletProfile } from '../../src/types/index';

// ─── Mock helpers (sleep) ─────────────────────────────────────────────────────

jest.mock('../../src/utils/helpers', () => ({
  ...jest.requireActual('../../src/utils/helpers'),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ADDRESS   = '0xaAbBcCdDeEfF0011223344556677889900aAbBcC';
const WALLET_A        = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B        = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FUNDER_ADDR     = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
const EXCHANGE_ADDR   = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';

function makeLogger(): Logger {
  return {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

function makeRedisCache(): jest.Mocked<RedisCache> {
  return {
    getWalletProfile:    jest.fn().mockResolvedValue(null),
    saveWalletProfile:   jest.fn().mockResolvedValue(undefined),
    getWalletFunder:     jest.fn().mockResolvedValue(null),
    cacheWalletFunder:   jest.fn().mockResolvedValue(undefined),
    hasAlertBeenSent:    jest.fn().mockResolvedValue(false),
    recordSentAlert:     jest.fn().mockResolvedValue(undefined),
    hasClusterAlertBeenSent: jest.fn().mockResolvedValue(false),
    recordClusterAlert:  jest.fn().mockResolvedValue(undefined),
    connect:             jest.fn().mockResolvedValue(undefined),
    disconnect:          jest.fn().mockResolvedValue(undefined),
    isConnected:         true,
  } as unknown as jest.Mocked<RedisCache>;
}

/** Build a minimal Alchemy success response */
function alchemyResponse(fromAddress: string, blockTimestamp: string) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        transfers: [
          { from: fromAddress, to: VALID_ADDRESS, metadata: { blockTimestamp } },
        ],
      },
    }),
  } as unknown as Response;
}

/** Build an Alchemy response with no transfers */
function alchemyEmptyResponse() {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: { transfers: [] },
    }),
  } as unknown as Response;
}

/** Build a Moralis success response */
function moralisResponse(fromAddress: string, blockTimestamp: string) {
  return {
    ok: true,
    json: async () => ({
      result: [
        { block_timestamp: blockTimestamp, from_address: fromAddress, to_address: VALID_ADDRESS },
      ],
    }),
  } as unknown as Response;
}

function makeAnalyzer(knownExchanges: string[] = []) {
  return new BlockchainAnalyzer('alchemy-key', 'moralis-key', knownExchanges, makeLogger());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Cache-first: no API call when Redis has profile (Req 5.1) ────────────────

describe('analyzeWalletProfile — cache-first', () => {
  it('returns cached profile without calling fetch when Redis hit', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const cache = makeRedisCache();
    const cachedProfile: WalletProfile = {
      address: VALID_ADDRESS,
      firstTransactionTimestamp: Date.now() - 1_000_000,
      transactionCount: 5,
      ageHours: 277,
      isNew: false,
      riskScore: 10,
    };
    cache.getWalletProfile.mockResolvedValue(cachedProfile);

    const analyzer = makeAnalyzer();
    const result = await analyzer.analyzeWalletProfile(VALID_ADDRESS, cache);

    expect(result).toEqual(cachedProfile);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves profile to Redis after Alchemy fetch on cache miss', async () => {
    const cache = makeRedisCache();
    jest.spyOn(global, 'fetch').mockResolvedValue(
      alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'),
    );

    const analyzer = makeAnalyzer();
    await analyzer.analyzeWalletProfile(VALID_ADDRESS, cache);

    expect(cache.saveWalletProfile).toHaveBeenCalledTimes(1);
    const saved: WalletProfile = cache.saveWalletProfile.mock.calls[0][0];
    expect(saved.address).toBe(VALID_ADDRESS);
  });
});

// ─── Moralis fallback when Alchemy fails (Req 5.4) ───────────────────────────

describe('analyzeWalletProfile — Moralis fallback', () => {
  it('uses Moralis when Alchemy throws', async () => {
    const cache = makeRedisCache();
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Alchemy network error'))
      .mockResolvedValueOnce(moralisResponse(FUNDER_ADDR, '2022-06-01T00:00:00.000Z'));

    const analyzer = makeAnalyzer();
    const result = await analyzer.analyzeWalletProfile(VALID_ADDRESS, cache);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.firstTransactionTimestamp).toBe(new Date('2022-06-01T00:00:00.000Z').getTime());
    expect(result.transactionCount).toBe(1);
  });

  it('uses Moralis when Alchemy returns HTTP error', async () => {
    const cache = makeRedisCache();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
      .mockResolvedValueOnce(moralisResponse(FUNDER_ADDR, '2022-06-01T00:00:00.000Z'));

    const analyzer = makeAnalyzer();
    const result = await analyzer.analyzeWalletProfile(VALID_ADDRESS, cache);

    expect(result.firstTransactionTimestamp).toBe(new Date('2022-06-01T00:00:00.000Z').getTime());
  });
});

// ─── 1-year-old assumption when both APIs fail (Req 5.5) ─────────────────────

describe('analyzeWalletProfile — both APIs fail', () => {
  it('returns 1-year-old fallback profile when Alchemy and Moralis both fail', async () => {
    const cache = makeRedisCache();
    jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Alchemy down'))
      .mockRejectedValueOnce(new Error('Moralis down'));

    const analyzer = makeAnalyzer();
    const before = Date.now();
    const result = await analyzer.analyzeWalletProfile(VALID_ADDRESS, cache);
    const after = Date.now();

    const oneYearMs = 365 * 24 * 3600 * 1000;
    expect(result.ageHours).toBe(8760);
    expect(result.isNew).toBe(false);
    expect(result.riskScore).toBe(10);
    expect(result.transactionCount).toBe(0);
    // firstTransactionTimestamp should be ~1 year ago
    expect(result.firstTransactionTimestamp).toBeGreaterThanOrEqual(before - oneYearMs - 100);
    expect(result.firstTransactionTimestamp).toBeLessThanOrEqual(after - oneYearMs + 100);
  });
});

// ─── analyzeClusterFunding: shared funders (Req 7.3) ─────────────────────────

describe('analyzeClusterFunding — shared funders', () => {
  it('identifies a common non-exchange funder for two wallets', async () => {
    const cache = makeRedisCache();
    // Both wallets funded by FUNDER_ADDR
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'))
      .mockResolvedValueOnce(alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'));

    const analyzer = makeAnalyzer();
    // Prime the redisCache by calling analyzeWalletProfile first
    analyzer['redisCache'] = cache;

    const result = await analyzer.analyzeClusterFunding([WALLET_A, WALLET_B]);

    expect(result.hasCommonNonExchangeFunder).toBe(true);
    expect(result.commonFunderAddress?.toLowerCase()).toBe(FUNDER_ADDR.toLowerCase());
    expect(result.isKnownExchange).toBe(false);
    expect(result.exchangeName).toBeNull();
  });

  it('returns no common funder when wallets have different funders', async () => {
    const cache = makeRedisCache();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'))
      .mockResolvedValueOnce(alchemyResponse('0x1111111111111111111111111111111111111111', '2023-01-01T00:00:00.000Z'));

    const analyzer = makeAnalyzer();
    analyzer['redisCache'] = cache;

    const result = await analyzer.analyzeClusterFunding([WALLET_A, WALLET_B]);

    expect(result.hasCommonNonExchangeFunder).toBe(false);
    expect(result.commonFunderAddress).toBeNull();
  });
});

// ─── Known exchange wallets NOT flagged as common funders (Req 7.4) ───────────

describe('analyzeClusterFunding — exchange wallets excluded', () => {
  it('does NOT set hasCommonNonExchangeFunder when funder is a known exchange', async () => {
    const cache = makeRedisCache();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(alchemyResponse(EXCHANGE_ADDR, '2023-01-01T00:00:00.000Z'))
      .mockResolvedValueOnce(alchemyResponse(EXCHANGE_ADDR, '2023-01-01T00:00:00.000Z'));

    const analyzer = makeAnalyzer([EXCHANGE_ADDR]);
    analyzer['redisCache'] = cache;

    const result = await analyzer.analyzeClusterFunding([WALLET_A, WALLET_B]);

    expect(result.hasCommonNonExchangeFunder).toBe(false);
    expect(result.isKnownExchange).toBe(true);
    expect(result.exchangeName).toBe('Exchange');
    expect(result.commonFunderAddress?.toLowerCase()).toBe(EXCHANGE_ADDR.toLowerCase());
  });
});

// ─── Partial failure: one wallet lookup fails, others succeed (Req 7.5) ───────

describe('analyzeClusterFunding — partial failure', () => {
  it('succeeds for remaining wallets when one lookup fails', async () => {
    const cache = makeRedisCache();
    // WALLET_A: Alchemy throws; WALLET_B: succeeds
    jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Alchemy timeout'))
      .mockResolvedValueOnce(alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'));

    const analyzer = makeAnalyzer();
    analyzer['redisCache'] = cache;

    const result = await analyzer.analyzeClusterFunding([WALLET_A, WALLET_B]);

    // WALLET_B funder should be recorded; WALLET_A skipped
    expect(result.funders.has(WALLET_B)).toBe(true);
    expect(result.funders.has(WALLET_A)).toBe(false);
    // Only one wallet funded by FUNDER_ADDR → no shared funder
    expect(result.hasCommonNonExchangeFunder).toBe(false);
  });
});

// ─── Redis caching of funder addresses prevents duplicate Alchemy calls (Req 7.1, 7.2) ──

describe('getWalletFunder — Redis caching', () => {
  it('returns cached funder without calling Alchemy when Redis has it', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const cache = makeRedisCache();
    cache.getWalletFunder.mockResolvedValue(FUNDER_ADDR);

    const analyzer = makeAnalyzer();
    analyzer['redisCache'] = cache;

    const funder = await analyzer.getWalletFunder(VALID_ADDRESS);

    expect(funder).toBe(FUNDER_ADDR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls Alchemy and caches result when Redis misses', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'),
    );
    const cache = makeRedisCache();
    cache.getWalletFunder.mockResolvedValue(null);

    const analyzer = makeAnalyzer();
    analyzer['redisCache'] = cache;

    const funder = await analyzer.getWalletFunder(VALID_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(funder).toBe(FUNDER_ADDR);
    expect(cache.cacheWalletFunder).toHaveBeenCalledWith(VALID_ADDRESS, FUNDER_ADDR);
  });

  it('does not call cacheWalletFunder when Alchemy returns no transfer', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(alchemyEmptyResponse());
    const cache = makeRedisCache();
    cache.getWalletFunder.mockResolvedValue(null);

    const analyzer = makeAnalyzer();
    analyzer['redisCache'] = cache;

    const funder = await analyzer.getWalletFunder(VALID_ADDRESS);

    expect(funder).toBeNull();
    expect(cache.cacheWalletFunder).not.toHaveBeenCalled();
  });

  it('prevents duplicate Alchemy calls for same wallet in cluster analysis', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(alchemyResponse(FUNDER_ADDR, '2023-01-01T00:00:00.000Z'));

    const cache = makeRedisCache();
    // First call: cache miss; second call: cache hit (simulating cacheWalletFunder effect)
    cache.getWalletFunder
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(FUNDER_ADDR);

    const analyzer = makeAnalyzer();
    analyzer['redisCache'] = cache;

    // Call getWalletFunder twice for the same address
    const funder1 = await analyzer.getWalletFunder(VALID_ADDRESS);
    const funder2 = await analyzer.getWalletFunder(VALID_ADDRESS);

    expect(funder1).toBe(FUNDER_ADDR);
    expect(funder2).toBe(FUNDER_ADDR);
    // Alchemy should only be called once — second call served from cache
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
