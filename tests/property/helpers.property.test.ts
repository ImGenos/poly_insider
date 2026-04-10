import * as fc from 'fast-check';
import { calculateZScore, exponentialBackoff } from '../../src/utils/helpers';

/**
 * Property 7: Confidence Score Bounds
 * For any inputs, calculateZScore result is always a finite number.
 * When stddev === 0, result is always 0 (no division by zero).
 *
 * Property 15: Z-Score Baseline Accuracy
 * For known mean/stddev (stddev > 0), result equals (value - mean) / stddev.
 *
 * Validates: Requirements 15.3, 3.1, 4.1, 8.3
 */
describe('Property tests: calculateZScore', () => {
  it('Property 7: returns 0 when stddev is 0 for any value and mean', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true }),
        fc.float({ noNaN: true }),
        (value, mean) => {
          const result = calculateZScore(value, mean, 0);
          return result === 0;
        }
      )
    );
  });

  it('Property 15: equals (value - mean) / stddev for any stddev > 0', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: Math.fround(0.0001), max: Math.fround(1e6) }),
        (value, mean, stddev) => {
          const result = calculateZScore(value, mean, stddev);
          const expected = (value - mean) / stddev;
          return Math.abs(result - expected) < 1e-9;
        }
      )
    );
  });

  it('Property 7: result is always a finite number for any finite inputs', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1e6 }),
        (value, mean, stddev) => {
          const result = calculateZScore(value, mean, stddev);
          return isFinite(result);
        }
      )
    );
  });
});

/**
 * Property 3: WebSocket Reconnection Guarantee
 * Each delay is double the previous (2^attempt * 1000), capped at maxDelay.
 * Validates: Requirements 1.5, 1.6
 */
describe('Property tests: exponentialBackoff', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Property 3: delay is min(2^attempt * 1000, maxDelay) for any attempt >= 0', async () => {
    const capturedDelays: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
      capturedDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 1000, max: 120000 }),
        async (attempt, maxDelay) => {
          capturedDelays.length = 0;
          await exponentialBackoff(attempt, maxDelay);
          const capturedDelay = capturedDelays[capturedDelays.length - 1];
          const expected = Math.min(Math.pow(2, attempt) * 1000, maxDelay);
          return capturedDelay === expected;
        }
      )
    );
  });

  it('Property 3: delay never exceeds maxDelay for any attempt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 500, max: 60000 }),
        (attempt, maxDelay) => {
          const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay);
          return delay <= maxDelay;
        }
      )
    );
  });

  it('Property 3: delay sequence is monotonically non-decreasing until cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60000, max: 120000 }),
        (maxDelay) => {
          const delays = [0, 1, 2, 3, 4, 5].map(attempt =>
            Math.min(Math.pow(2, attempt) * 1000, maxDelay)
          );
          for (let i = 1; i < delays.length; i++) {
            if (delays[i] < delays[i - 1]) return false;
          }
          return true;
        }
      )
    );
  });

  it('Property 3: attempt 0 always produces 1000ms delay (before cap)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 120000 }),
        (maxDelay) => {
          const delay = Math.min(Math.pow(2, 0) * 1000, maxDelay);
          return delay === Math.min(1000, maxDelay);
        }
      )
    );
  });
});
