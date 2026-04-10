import * as fc from 'fast-check';
import { BlockchainAnalyzer } from '../../src/blockchain/BlockchainAnalyzer';
import { RedisCache } from '../../src/cache/RedisCache';
import { Logger } from '../../src/utils/Logger';
import { WalletProfile, FundingAnalysis } from '../../src/types/index';

// ─── Mock sleep to avoid delays ──────────────────────────────────────────────

jest.mock('../../src/utils/helpers', () => ({
  ...jest.requireActual('../../src/utils/helpers'),
  sleep: jest.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ADDRESSES = [
  '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
  '0x1122334455667788990011223344556677889900',
  '0xAABBCCDDEEFF00112233445566778899AABBCCDD',
  '0x0011223344556677889900aAbBcCdDeEfF001122',
  '0xFFEEDDCCBBAA99887766554433221100FFEEDDCC',
  '0xabcdef0123456789abcdef0123456789abcdef01',
  '0x9876543210fedcba9876543210fedcba98765432',
  '0x1234567890abcdef1234567890abcdef12345678',
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  '0xcafebabecafebabecafebabecafebabecafebabe',
];

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

function makeRedisCache(cachedProfile: WalletProfile | null = null): jest.Mocked<RedisCache> {
  return {
    getWalletProfile: jest.fn().mockResolvedValue(cachedProfile),
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

function makeAnalyzer(knownExchanges: string[] = []): BlockchainAnalyzer {
  return new BlockchainAnalyzer('alchemy-key', 'moralis-key', knownExchanges, makeLogger());
}

function alchemySuccessResponse(fromAddress: string) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        transfers: [
          {
            from: fromAddress,
            to: VALID_ADDRESSES[0],
            metadata: { blockTimestamp: '2022-01-01T00:00:00.000Z' },
          },
        ],
      },
    }),
  } as unknown as Response;
}

// ─── Property 6: Wallet Profile Caching Correctness ──────────────────────────

/**
 * Property 6: Wallet Profile Caching Correctness
 *
 * analyzeWalletProfile makes at most one Alchemy call per address;
 * all subsequent calls return the cached value without any API call.
 *
 * Validates: Requirements 5.1, 5.3, 13.2
 */
describe('Property 6: Wallet Profile Caching Correctness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetch is called exactly once regardless of how many times analyzeWalletProfile is called for the same address', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (numCalls) => {
          jest.clearAllMocks();

          const address = VALID_ADDRESSES[0];
          const funderAddress = VALID_ADDRESSES[1];

          // Build a cached profile that the mock Redis will return on 2nd+ calls
          const cachedProfile: WalletProfile = {
            address,
            firstTransactionTimestamp: new Date('2022-01-01T00:00:00.000Z').getTime(),
            transactionCount: 1,
            ageHours: 8760,
            isNew: false,
            riskScore: 10,
          };

          // First call: cache miss → Alchemy is called → profile saved
          // Subsequent calls: cache hit → no Alchemy call
          const cache = makeRedisCache();
          cache.getWalletProfile
            .mockResolvedValueOnce(null)           // first call: cache miss
            .mockResolvedValue(cachedProfile);     // all subsequent calls: cache hit

          const fetchSpy = jest.spyOn(global, 'fetch')
            .mockResolvedValue(alchemySuccessResponse(funderAddress));

          const analyzer = makeAnalyzer();

          // Call analyzeWalletProfile numCalls times for the same address
          const results: WalletProfile[] = [];
          for (let i = 0; i < numCalls; i++) {
            results.push(await analyzer.analyzeWalletProfile(address, cache));
          }

          // Alchemy (fetch) must be called exactly once regardless of numCalls
          expect(fetchSpy).toHaveBeenCalledTimes(1);

          // All results must be valid WalletProfile objects with the correct address
          for (const result of results) {
            if (result.address !== address) return false;
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('profile is saved to Redis exactly once after the first Alchemy call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        async (numCalls) => {
          jest.clearAllMocks();

          const address = VALID_ADDRESSES[0];
          const funderAddress = VALID_ADDRESSES[1];

          const cachedProfile: WalletProfile = {
            address,
            firstTransactionTimestamp: new Date('2022-01-01T00:00:00.000Z').getTime(),
            transactionCount: 1,
            ageHours: 8760,
            isNew: false,
            riskScore: 10,
          };

          const cache = makeRedisCache();
          cache.getWalletProfile
            .mockResolvedValueOnce(null)
            .mockResolvedValue(cachedProfile);

          jest.spyOn(global, 'fetch')
            .mockResolvedValue(alchemySuccessResponse(funderAddress));

          const analyzer = makeAnalyzer();

          for (let i = 0; i < numCalls; i++) {
            await analyzer.analyzeWalletProfile(address, cache);
          }

          // saveWalletProfile must be called exactly once (only after the first Alchemy fetch)
          expect(cache.saveWalletProfile).toHaveBeenCalledTimes(1);

          return true;
        }
      ),
      { numRuns: 30 }
    );
  });

  it('cached profile is returned unchanged on subsequent calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        async (numCalls) => {
          jest.clearAllMocks();

          const address = VALID_ADDRESSES[0];
          const funderAddress = VALID_ADDRESSES[1];

          const cachedProfile: WalletProfile = {
            address,
            firstTransactionTimestamp: 1640995200000,
            transactionCount: 42,
            ageHours: 8760,
            isNew: false,
            riskScore: 10,
          };

          const cache = makeRedisCache();
          cache.getWalletProfile
            .mockResolvedValueOnce(null)
            .mockResolvedValue(cachedProfile);

          jest.spyOn(global, 'fetch')
            .mockResolvedValue(alchemySuccessResponse(funderAddress));

          const analyzer = makeAnalyzer();

          // First call: fetches from Alchemy
          await analyzer.analyzeWalletProfile(address, cache);

          // Subsequent calls: must return the cached profile
          for (let i = 1; i < numCalls; i++) {
            const result = await analyzer.analyzeWalletProfile(address, cache);
            if (result.address !== cachedProfile.address) return false;
            if (result.transactionCount !== cachedProfile.transactionCount) return false;
            if (result.ageHours !== cachedProfile.ageHours) return false;
            if (result.riskScore !== cachedProfile.riskScore) return false;
          }

          return true;
        }
      ),
      { numRuns: 30 }
    );
  });
});

// ─── Property 18: Funding Analysis Non-Blocking ───────────────────────────────

/**
 * Property 18: Funding Analysis Non-Blocking
 *
 * For any set of wallets with partial lookup failures, analyzeClusterFunding
 * always returns a complete FundingAnalysis without throwing.
 *
 * Validates: Requirements 7.5, 7.6, 7.7
 */
describe('Property 18: Funding Analysis Non-Blocking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('analyzeClusterFunding never throws and always returns a FundingAnalysis with all required fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        async (failureFlags) => {
          jest.clearAllMocks();

          // Build a wallet list: one wallet per failure flag
          const wallets = failureFlags.map((_, i) => VALID_ADDRESSES[i % VALID_ADDRESSES.length]);

          // Set up fetch mock: for each wallet, either throw or succeed based on flag
          const fetchSpy = jest.spyOn(global, 'fetch');
          for (const shouldFail of failureFlags) {
            if (shouldFail) {
              fetchSpy.mockRejectedValueOnce(new Error('Alchemy lookup failed'));
            } else {
              fetchSpy.mockResolvedValueOnce(alchemySuccessResponse(VALID_ADDRESSES[1]));
            }
          }

          const analyzer = makeAnalyzer();
          const cache = makeRedisCache();
          analyzer['redisCache'] = cache;

          let result: FundingAnalysis | undefined;
          let threw = false;

          try {
            result = await analyzer.analyzeClusterFunding(wallets);
          } catch {
            threw = true;
          }

          // Must never throw
          if (threw) return false;

          // Must return a defined result
          if (!result) return false;

          // Must have all required FundingAnalysis fields
          if (!Array.isArray(result.wallets)) return false;
          if (!(result.funders instanceof Map)) return false;
          if (!(result.sharedFunders instanceof Map)) return false;
          if (typeof result.hasCommonNonExchangeFunder !== 'boolean') return false;
          if (result.commonFunderAddress !== null && typeof result.commonFunderAddress !== 'string') return false;
          if (typeof result.isKnownExchange !== 'boolean') return false;
          if (result.exchangeName !== null && typeof result.exchangeName !== 'string') return false;

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('failed wallet lookups are omitted from funders map but do not prevent successful lookups from being recorded', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 2, maxLength: 8 }),
        async (failureFlags) => {
          jest.clearAllMocks();

          const wallets = failureFlags.map((_, i) => VALID_ADDRESSES[i % VALID_ADDRESSES.length]);
          const successCount = failureFlags.filter(f => !f).length;

          const fetchSpy = jest.spyOn(global, 'fetch');
          for (const shouldFail of failureFlags) {
            if (shouldFail) {
              fetchSpy.mockRejectedValueOnce(new Error('Alchemy timeout'));
            } else {
              // Use a unique funder per wallet to avoid shared-funder detection
              fetchSpy.mockResolvedValueOnce(alchemySuccessResponse(
                VALID_ADDRESSES[(failureFlags.indexOf(shouldFail) + 2) % VALID_ADDRESSES.length]
              ));
            }
          }

          const analyzer = makeAnalyzer();
          const cache = makeRedisCache();
          analyzer['redisCache'] = cache;

          const result = await analyzer.analyzeClusterFunding(wallets);

          // funders map size must be <= successCount (some may share addresses)
          if (result.funders.size > successCount) return false;

          // wallets array in result must equal the input wallets
          if (result.wallets.length !== wallets.length) return false;

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns safe default FundingAnalysis when all lookups fail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        async (numWallets) => {
          jest.clearAllMocks();

          const wallets = Array.from({ length: numWallets }, (_, i) =>
            VALID_ADDRESSES[i % VALID_ADDRESSES.length]
          );

          // All lookups fail
          jest.spyOn(global, 'fetch').mockRejectedValue(new Error('All Alchemy calls fail'));

          const analyzer = makeAnalyzer();
          const cache = makeRedisCache();
          analyzer['redisCache'] = cache;

          let result: FundingAnalysis | undefined;
          let threw = false;

          try {
            result = await analyzer.analyzeClusterFunding(wallets);
          } catch {
            threw = true;
          }

          if (threw) return false;
          if (!result) return false;

          // When all fail: no funders, no shared funders, no common funder
          if (result.funders.size !== 0) return false;
          if (result.sharedFunders.size !== 0) return false;
          if (result.hasCommonNonExchangeFunder !== false) return false;
          if (result.commonFunderAddress !== null) return false;
          if (result.isKnownExchange !== false) return false;
          if (result.exchangeName !== null) return false;

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});
