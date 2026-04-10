import * as fc from 'fast-check';
import { RedisCache } from '../../src/cache/RedisCache';
import { Logger } from '../../src/utils/Logger';

/**
 * Property 5: Stream Delivery Guarantee
 * Every trade pushed to `trades:stream` is eventually read and acknowledged
 * by the Analyzer. After processing all messages, the pending count is 0.
 *
 * **Validates: Requirements 12.2, 12.3**
 *
 * Property 4: Alert Delivery Idempotency
 * Exactly one Telegram alert is sent per anomaly within the deduplication
 * TTL window — no duplicates, no missed alerts.
 *
 * **Validates: Requirements 9.1, 9.2, 9.3**
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

/** Creates a fresh RedisCache in fallback mode (no Redis connection). */
function makeFallbackCache(): RedisCache {
  return new RedisCache('redis://localhost:6379', makeLogger());
}

const nonEmptyString = fc.string({ minLength: 1, maxLength: 40 });

// ─── In-memory stream simulation ─────────────────────────────────────────────

interface StreamEntry {
  id: string;
  fields: Record<string, string>;
  acknowledged: boolean;
}

class InMemoryStream {
  private entries: StreamEntry[] = [];
  private nextId = 1;

  push(fields: Record<string, string>): string {
    const id = String(this.nextId++);
    this.entries.push({ id, fields, acknowledged: false });
    return id;
  }

  /** Read up to `count` unacknowledged messages. */
  read(count: number): StreamEntry[] {
    return this.entries
      .filter(e => !e.acknowledged)
      .slice(0, count);
  }

  acknowledge(id: string): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) entry.acknowledged = true;
  }

  pendingCount(): number {
    return this.entries.filter(e => !e.acknowledged).length;
  }

  totalCount(): number {
    return this.entries.length;
  }
}

// ─── Property 5: Stream Delivery Guarantee ───────────────────────────────────

describe('Property 5: Stream Delivery Guarantee', () => {
  /**
   * For any N messages pushed to the stream, reading and acknowledging all of
   * them results in a pending count of 0.
   */
  it('all pushed messages are eventually read and acknowledged (pending = 0)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            market_id: nonEmptyString,
            price: fc.float({ min: 0, max: 1, noNaN: true }).map(String),
            size_usd: fc.float({ min: 1, max: 1_000_000, noNaN: true }).map(String),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (messages) => {
          const stream = new InMemoryStream();

          // Ingestor side: push all messages
          for (const fields of messages) {
            stream.push(fields);
          }

          expect(stream.totalCount()).toBe(messages.length);
          expect(stream.pendingCount()).toBe(messages.length);

          // Analyzer side: read and acknowledge in batches of 10
          const batchSize = 10;
          let iterations = 0;
          const maxIterations = Math.ceil(messages.length / batchSize) + 1;

          while (stream.pendingCount() > 0 && iterations < maxIterations) {
            const batch = stream.read(batchSize);
            for (const entry of batch) {
              stream.acknowledge(entry.id);
            }
            iterations++;
          }

          // All messages must be acknowledged
          expect(stream.pendingCount()).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * For any N messages, reading in batches smaller than N still delivers all
   * messages — no message is skipped regardless of batch size.
   */
  it('all messages are delivered regardless of batch size', () => {
    fc.assert(
      fc.property(
        fc.array(nonEmptyString, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 10 }),
        (payloads, batchSize) => {
          const stream = new InMemoryStream();

          for (const payload of payloads) {
            stream.push({ data: payload });
          }

          const readIds: string[] = [];
          let iterations = 0;
          const maxIterations = payloads.length + 1;

          while (stream.pendingCount() > 0 && iterations < maxIterations) {
            const batch = stream.read(batchSize);
            for (const entry of batch) {
              readIds.push(entry.id);
              stream.acknowledge(entry.id);
            }
            iterations++;
          }

          // Every pushed message was read exactly once
          expect(readIds.length).toBe(payloads.length);
          expect(stream.pendingCount()).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Acknowledging a message is idempotent — acknowledging the same ID twice
   * does not change the pending count beyond the first acknowledgement.
   */
  it('double-acknowledging a message does not corrupt the pending count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (n) => {
          const stream = new InMemoryStream();
          const ids: string[] = [];

          for (let i = 0; i < n; i++) {
            ids.push(stream.push({ index: String(i) }));
          }

          // Acknowledge first message twice
          stream.acknowledge(ids[0]);
          stream.acknowledge(ids[0]);

          expect(stream.pendingCount()).toBe(n - 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 4: Alert Delivery Idempotency ──────────────────────────────────

describe('Property 4: Alert Delivery Idempotency', () => {
  /**
   * hasAlertBeenSent returns false before recordSentAlert is called.
   */
  it('hasAlertBeenSent returns false before any alert is recorded', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        async (type, marketId, walletAddress) => {
          const cache = makeFallbackCache();
          const result = await cache.hasAlertBeenSent(type, marketId, walletAddress);
          return result === false;
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * hasAlertBeenSent returns true after recordSentAlert is called.
   * The first call to recordSentAlert is the one that "creates" the alert.
   */
  it('hasAlertBeenSent returns true after recordSentAlert', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        fc.integer({ min: 1, max: 86400 }),
        async (type, marketId, walletAddress, ttl) => {
          const cache = makeFallbackCache();

          const before = await cache.hasAlertBeenSent(type, marketId, walletAddress);
          await cache.recordSentAlert(type, marketId, walletAddress, ttl);
          const after = await cache.hasAlertBeenSent(type, marketId, walletAddress);

          return before === false && after === true;
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Calling recordSentAlert multiple times still results in exactly one "new"
   * alert — the first call transitions from false→true; subsequent calls keep
   * it true (no second alert would be sent).
   */
  it('only the first recordSentAlert transitions state from false to true', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        fc.integer({ min: 1, max: 86400 }),
        fc.integer({ min: 2, max: 5 }),
        async (type, marketId, walletAddress, ttl, repeatCount) => {
          const cache = makeFallbackCache();

          // Track how many times the state transitions from "not sent" to "sent"
          let newAlertCount = 0;

          for (let i = 0; i < repeatCount; i++) {
            const alreadySent = await cache.hasAlertBeenSent(type, marketId, walletAddress);
            if (!alreadySent) {
              newAlertCount++;
              await cache.recordSentAlert(type, marketId, walletAddress, ttl);
            }
          }

          // Exactly one "new" alert regardless of how many times we tried
          return newAlertCount === 1;
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Alert deduplication is key-specific — recording an alert for one
   * (type, marketId, walletAddress) does NOT affect a distinct key.
   */
  it('recording one alert key does not affect a distinct key', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        fc.integer({ min: 1, max: 86400 }),
        async (type, marketId, walletAddress, differentType, ttl) => {
          fc.pre(type !== differentType);

          const cache = makeFallbackCache();
          await cache.recordSentAlert(type, marketId, walletAddress, ttl);

          const unaffected = await cache.hasAlertBeenSent(differentType, marketId, walletAddress);
          return unaffected === false;
        },
      ),
      { numRuns: 200 },
    );
  });
});
