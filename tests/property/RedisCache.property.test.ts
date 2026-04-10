import * as fc from 'fast-check';
import { RedisCache } from '../../src/cache/RedisCache';
import { Logger } from '../../src/utils/Logger';

/**
 * Property 14: Alert Deduplication via Redis TTL
 * - 14a: After recordSentAlert(...), hasAlertBeenSent(...) returns true
 * - 14b: Recording one alert key does NOT affect a distinct key (independence)
 * - 14c: After recordClusterAlert(marketId, side), hasClusterAlertBeenSent returns true
 *
 * Uses the in-memory fallback path (no Redis connection) for deterministic testing.
 *
 * Validates: Requirements 9.3, 9.4
 */

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  }));
});

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

/** Creates a fresh RedisCache in fallback mode (no connect call). */
function makeFallbackCache(): RedisCache {
  return new RedisCache('redis://localhost:6379', makeLogger());
}

// Non-empty string arbitrary to avoid degenerate empty-string keys
const nonEmptyString = fc.string({ minLength: 1, maxLength: 40 });

describe('Property 14: Alert Deduplication via Redis TTL (in-memory fallback)', () => {

  /**
   * Property 14a: For any (type, marketId, walletAddress),
   * after recordSentAlert(...), hasAlertBeenSent(...) returns true.
   */
  it('Property 14a: hasAlertBeenSent returns true after recordSentAlert for any key', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        fc.integer({ min: 1, max: 86400 }),
        async (type, marketId, walletAddress, ttl) => {
          const cache = makeFallbackCache();
          await cache.recordSentAlert(type, marketId, walletAddress, ttl);
          const result = await cache.hasAlertBeenSent(type, marketId, walletAddress);
          return result === true;
        }
      )
    );
  });

  /**
   * Property 14b: For any two distinct alert keys, recording one does NOT
   * affect the other (independence of keys in the dedup map).
   * Two keys are distinct if they differ in at least one of type, marketId, walletAddress.
   */
  it('Property 14b: recording one alert key does not affect a distinct key', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        fc.integer({ min: 1, max: 86400 }),
        async (type, marketId, walletAddress, differentType, ttl) => {
          // Ensure the two keys are distinct by using a different type
          fc.pre(type !== differentType);

          const cache = makeFallbackCache();
          await cache.recordSentAlert(type, marketId, walletAddress, ttl);

          // The distinct key (differentType) should NOT be marked as sent
          const unaffected = await cache.hasAlertBeenSent(differentType, marketId, walletAddress);
          return unaffected === false;
        }
      )
    );
  });

  /**
   * Property 14c: For any (marketId, side), after recordClusterAlert(marketId, side),
   * hasClusterAlertBeenSent(marketId, side) returns true.
   */
  it('Property 14c: hasClusterAlertBeenSent returns true after recordClusterAlert', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        fc.constantFrom('YES', 'NO'),
        fc.integer({ min: 1, max: 86400 }),
        async (marketId, side, ttl) => {
          const cache = makeFallbackCache();
          await cache.recordClusterAlert(marketId, side, ttl);
          const result = await cache.hasClusterAlertBeenSent(marketId, side);
          return result === true;
        }
      )
    );
  });

  /**
   * Property 14b (cluster variant): recording a cluster alert for one (marketId, side)
   * does NOT affect a distinct (marketId, side) pair.
   */
  it('Property 14b (cluster): recording one cluster key does not affect a distinct cluster key', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        fc.integer({ min: 1, max: 86400 }),
        async (marketId, differentMarketId, ttl) => {
          fc.pre(marketId !== differentMarketId);

          const cache = makeFallbackCache();
          await cache.recordClusterAlert(marketId, 'YES', ttl);

          const unaffected = await cache.hasClusterAlertBeenSent(differentMarketId, 'YES');
          return unaffected === false;
        }
      )
    );
  });
});
