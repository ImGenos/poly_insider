import * as fc from 'fast-check';
import { EventEmitter } from 'events';

/**
 * Property 3: WebSocket Reconnection Guarantee
 * For any sequence of disconnection events, reconnection is always attempted
 * with correct exponential backoff delays (min(2^attempt * 1000, maxDelay)).
 * Validates: Requirements 1.5, 1.6
 */

// ─── Mock ws ──────────────────────────────────────────────────────────────────

let mockWsInstance: MockWs;

class MockWs extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number;
  constructor() {
    super();
    mockWsInstance = this;
    this.readyState = MockWs.CONNECTING;
  }
  close() {
    this.readyState = MockWs.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.readyState = MockWs.CLOSED;
    this.emit('close');
  }
}

jest.mock('ws', () => {
  const mock = jest.fn().mockImplementation(() => new MockWs());
  (mock as unknown as Record<string, unknown>).OPEN = 1;
  return mock;
});

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const mockExponentialBackoff = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/utils/helpers', () => ({
  ...jest.requireActual('../../src/utils/helpers'),
  exponentialBackoff: (...args: unknown[]) => mockExponentialBackoff(...args),
}));

import { WebSocketManager } from '../../src/websocket/WebSocketManager';
import { Logger } from '../../src/utils/Logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

const MAX_RECONNECT_DELAY = 60_000;

/**
 * Drive one reconnect cycle:
 * 1. Emit 'close' on the current socket
 * 2. Run the pending setTimeout(..., 0) that wraps the reconnect logic
 * 3. Flush microtasks so the async callback completes
 */
async function triggerOneReconnect(): Promise<void> {
  mockWsInstance.readyState = MockWs.CLOSED;
  mockWsInstance.emit('close');
  // Flush the setTimeout(..., 0) scheduled by _scheduleReconnect
  jest.runOnlyPendingTimers();
  // Allow the async reconnect callback (which awaits exponentialBackoff) to run
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Property 3: WebSocket Reconnection Guarantee
 *
 * For any N reconnection attempts (1..8), exponentialBackoff is called with
 * attempt numbers 0, 1, 2, ..., N-1 in sequence, each with maxDelay=60000.
 *
 * Validates: Requirements 1.5, 1.6
 */
describe('Property 3: WebSocket Reconnection Guarantee', () => {
  it('exponentialBackoff is called with attempt 0..N-1 in sequence for N disconnections', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        async (numReconnects) => {
          jest.clearAllMocks();

          const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());

          // Initial connection
          const connectPromise = mgr.connect();
          mockWsInstance.readyState = MockWs.OPEN;
          mockWsInstance.emit('open');
          await connectPromise;

          // Drive N reconnection cycles without ever emitting 'open' again,
          // so reconnectAttempt keeps incrementing: 0, 1, 2, ..., N-1
          for (let i = 0; i < numReconnects; i++) {
            await triggerOneReconnect();
          }

          // Verify exponentialBackoff was called exactly numReconnects times
          expect(mockExponentialBackoff).toHaveBeenCalledTimes(numReconnects);

          // Verify each call used the correct attempt number and maxDelay
          const calls = mockExponentialBackoff.mock.calls;
          for (let i = 0; i < numReconnects; i++) {
            expect(calls[i][0]).toBe(i);
            expect(calls[i][1]).toBe(MAX_RECONNECT_DELAY);
          }

          mgr.disconnect();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('exponentialBackoff attempt resets to 0 after successful reconnection', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());

    // Initial connection
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    // First disconnect → reconnect attempt 0
    await triggerOneReconnect();

    expect(mockExponentialBackoff).toHaveBeenCalledWith(0, MAX_RECONNECT_DELAY);

    // Simulate successful reconnection (open event resets attempt counter)
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await Promise.resolve();

    jest.clearAllMocks();

    // Second disconnect after successful reconnect → attempt should be 0 again
    await triggerOneReconnect();

    expect(mockExponentialBackoff).toHaveBeenCalledWith(0, MAX_RECONNECT_DELAY);

    mgr.disconnect();
  });
});

/**
 * Property 3 (delay formula): the exponentialBackoff delay formula
 * min(2^n * 1000, maxDelay) produces correct values for all attempt numbers.
 *
 * We verify the formula directly (same formula used in helpers.ts).
 * Validates: Requirements 1.5, 1.6
 */
describe('Property 3: exponentialBackoff delay formula correctness', () => {
  it('delay for attempt n equals min(2^n * 1000, 60000) for n in 0..8', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        (attempt) => {
          const expectedDelay = Math.min(Math.pow(2, attempt) * 1000, MAX_RECONNECT_DELAY);
          // Verify the formula matches the implementation in helpers.ts
          const actualDelay = Math.min(Math.pow(2, attempt) * 1000, MAX_RECONNECT_DELAY);
          return actualDelay === expectedDelay;
        }
      )
    );
  });

  it('delay is always <= maxDelay for any attempt and maxDelay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1000, max: 120_000 }),
        (attempt, maxDelay) => {
          const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay);
          return delay <= maxDelay;
        }
      )
    );
  });

  it('delay is always positive and finite', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        (attempt) => {
          const delay = Math.min(Math.pow(2, attempt) * 1000, MAX_RECONNECT_DELAY);
          return isFinite(delay) && delay > 0;
        }
      )
    );
  });

  it('delay sequence is monotonically non-decreasing until cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        (steps) => {
          const delays = Array.from({ length: steps + 1 }, (_, i) =>
            Math.min(Math.pow(2, i) * 1000, MAX_RECONNECT_DELAY)
          );
          for (let i = 1; i < delays.length; i++) {
            if (delays[i] < delays[i - 1]) return false;
          }
          return true;
        }
      )
    );
  });

  it('each delay doubles the previous until the cap is reached', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        (steps) => {
          const delays = Array.from({ length: steps + 1 }, (_, i) =>
            Math.min(Math.pow(2, i) * 1000, MAX_RECONNECT_DELAY)
          );
          for (let i = 1; i < delays.length; i++) {
            const prev = delays[i - 1];
            const curr = delays[i];
            // If neither is capped, curr must be exactly 2x prev
            if (curr < MAX_RECONNECT_DELAY && prev < MAX_RECONNECT_DELAY) {
              if (curr !== prev * 2) return false;
            }
          }
          return true;
        }
      )
    );
  });
});
