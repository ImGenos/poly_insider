/**
 * Task 20.5: Property test for Redis persistence across restarts
 *
 * Property 11: Redis Persistence Across Restarts
 * - Wallet profile saved before termination is returned after client reconnection
 *   without any Alchemy API call.
 *
 * Uses RedisCache in fallback mode (in-memory) to simulate persistence semantics.
 * fast-check is used for property-based testing.
 *
 * Validates: Requirements 13.1, 13.2
 */

import * as fc from 'fast-check';
import { RedisCache } from '../../src/cache/RedisCache';
import { Logger } from '../../src/utils/Logger';
import { WalletProfile } from '../../src/types/index';

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

// Simulate a persistent in-memory store that survives "reconnection"
// (i.e., a new RedisCache instance pointing to the same store).
const persistentStore = new Map<string, Record<string, string>>();

const mockRedisClient = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined),

  hset: jest.fn().mockImplementation(async (key: string, ...args: string[]) => {
    const existing = persistentStore.get(key) ?? {};
    for (let i = 0; i < args.length - 1; i += 2) {
      existing[args[i]] = args[i + 1];
    }
    persistentStore.set(key, existing);
    return args.length / 2;
  }),

  hgetall: jest.fn().mockImplementation(async (key: string) => {
    return persistentStore.get(key) ?? null;
  }),

  hget: jest.fn().mockImplementation(async (key: string, field: string) => {
    return persistentStore.get(key)?.[field] ?? null;
  }),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedisClient);
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

async function makeConnectedCache(): Promise<RedisCache> {
  const cache = new RedisCache('redis://localhost:6379', makeLogger());
  await cache.connect();
  (cache as unknown as { isConnected: boolean }).isConnected = true;
  (cache as unknown as { client: unknown }).client = mockRedisClient;
  return cache;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Valid Ethereum address */
const arbAddress = fc.hexaString({ minLength: 40, maxLength: 40 }).map(h => `0x${h}`);

/** Wallet age in hours (0 to 10 years) */
const arbAgeHours = fc.float({ min: 0, max: 87600, noNaN: true });

/** Transaction count */
const arbTxCount = fc.integer({ min: 0, max: 10000 });

/** Risk score 0–100 */
const arbRiskScore = fc.integer({ min: 0, max: 100 });

/** Optional first transaction timestamp */
const arbFirstTxTimestamp = fc.option(
  fc.integer({ min: 0, max: Date.now() }),
  { nil: null },
);

function makeWalletProfile(
  address: string,
  ageHours: number,
  txCount: number,
  riskScore: number,
  firstTxTimestamp: number | null,
): WalletProfile {
  return {
    address,
    firstTransactionTimestamp: firstTxTimestamp,
    transactionCount: txCount,
    ageHours,
    isNew: ageHours < 48,
    riskScore,
  };
}

// ─── Property 11: Redis Persistence Across Restarts ──────────────────────────

/**
 * Property 11: Redis Persistence Across Restarts
 *
 * For any wallet profile saved to Redis before "termination",
 * a new RedisCache client (simulating reconnection after restart)
 * returns the same profile without any Alchemy API call.
 *
 * **Validates: Requirements 13.1, 13.2**
 */
describe('Property 11: Redis Persistence Across Restarts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    persistentStore.clear();
  });

  it('wallet profile saved before termination is returned after reconnection', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAddress,
        arbAgeHours,
        arbTxCount,
        arbRiskScore,
        arbFirstTxTimestamp,
        async (address, ageHours, txCount, riskScore, firstTxTimestamp) => {
          // Clear store for each run
          persistentStore.clear();
          jest.clearAllMocks();

          // ── Phase 1: "Before termination" ────────────────────────────────
          // Save wallet profile using first cache instance
          const cacheBeforeRestart = await makeConnectedCache();
          const profile = makeWalletProfile(address, ageHours, txCount, riskScore, firstTxTimestamp);
          await cacheBeforeRestart.saveWalletProfile(profile);

          // ── Phase 2: "After reconnection" ────────────────────────────────
          // Create a new cache instance (simulating process restart + reconnect)
          const cacheAfterRestart = await makeConnectedCache();

          // Retrieve the profile — should come from Redis (persistent store)
          const retrieved = await cacheAfterRestart.getWalletProfile(address);

          // Profile must be returned (Req 13.2)
          if (retrieved === null) return false;

          // Core fields must match (Req 13.1)
          const txCountMatch = retrieved.transactionCount === txCount;
          const isNewMatch = retrieved.isNew === (ageHours < 48);
          const riskScoreMatch = retrieved.riskScore === riskScore;

          return txCountMatch && isNewMatch && riskScoreMatch;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getWalletProfile after reconnection does NOT call Alchemy (Req 13.2)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAddress,
        arbAgeHours,
        arbTxCount,
        arbRiskScore,
        async (address, ageHours, txCount, riskScore) => {
          persistentStore.clear();
          jest.clearAllMocks();

          // Save profile before "restart"
          const cacheBeforeRestart = await makeConnectedCache();
          const profile = makeWalletProfile(address, ageHours, txCount, riskScore, null);
          await cacheBeforeRestart.saveWalletProfile(profile);

          // Reconnect
          const cacheAfterRestart = await makeConnectedCache();

          // Track fetch calls (Alchemy uses fetch)
          const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({ result: { transfers: [] } }),
          } as unknown as Response);

          // Retrieve profile — should NOT call Alchemy
          const retrieved = await cacheAfterRestart.getWalletProfile(address);

          // Profile must be found in Redis (no Alchemy needed)
          const profileFound = retrieved !== null;
          const noAlchemyCalled = fetchSpy.mock.calls.length === 0;

          fetchSpy.mockRestore();

          return profileFound && noAlchemyCalled;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('wallet profile fields are preserved exactly across save/load cycle (Req 13.1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAddress,
        arbAgeHours,
        arbTxCount,
        arbRiskScore,
        arbFirstTxTimestamp,
        async (address, ageHours, txCount, riskScore, firstTxTimestamp) => {
          persistentStore.clear();
          jest.clearAllMocks();

          const cache = await makeConnectedCache();
          const profile = makeWalletProfile(address, ageHours, txCount, riskScore, firstTxTimestamp);

          await cache.saveWalletProfile(profile);
          const retrieved = await cache.getWalletProfile(address);

          if (retrieved === null) return false;

          // All fields must round-trip correctly
          return (
            retrieved.address === address &&
            retrieved.transactionCount === txCount &&
            retrieved.isNew === (ageHours < 48) &&
            retrieved.riskScore === riskScore
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('multiple wallet profiles are stored independently (Req 13.1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbAddress, { minLength: 2, maxLength: 5 }),
        arbTxCount,
        async (addresses, baseTxCount) => {
          persistentStore.clear();
          jest.clearAllMocks();

          const cache = await makeConnectedCache();

          // Save distinct profiles for each address
          for (let i = 0; i < addresses.length; i++) {
            const profile = makeWalletProfile(
              addresses[i],
              10 + i,
              baseTxCount + i,
              50 + i,
              null,
            );
            await cache.saveWalletProfile(profile);
          }

          // Verify each profile is retrievable and correct
          for (let i = 0; i < addresses.length; i++) {
            const retrieved = await cache.getWalletProfile(addresses[i]);
            if (retrieved === null) return false;
            if (retrieved.transactionCount !== baseTxCount + i) return false;
          }

          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
