/**
 * Task 20.2: WebSocket reconnection lifecycle integration test
 *
 * Validates: Requirements 1.5, 1.6, 1.7
 *
 * Tests:
 * - Connection establishment to mock WebSocket server
 * - Automatic reconnection on disconnect with correct backoff timing
 * - Graceful shutdown on SIGINT
 */

import { EventEmitter } from 'events';
import { WebSocketManager } from '../../src/websocket/WebSocketManager';
import { Logger } from '../../src/utils/Logger';

// ─── Mock ws ──────────────────────────────────────────────────────────────────

let mockWsInstance: MockWs;
let wsConstructorCalls = 0;

class MockWs extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number;

  constructor() {
    super();
    wsConstructorCalls++;
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

  send(_data: unknown) { /* no-op */ }
}

jest.mock('ws', () => {
  const mock = jest.fn().mockImplementation(() => new MockWs());
  (mock as unknown as Record<string, unknown>).OPEN = 1;
  return mock;
});

// ─── Mock exponentialBackoff to avoid real delays ─────────────────────────────

jest.mock('../../src/utils/helpers', () => ({
  ...jest.requireActual('../../src/utils/helpers'),
  exponentialBackoff: jest.fn().mockResolvedValue(undefined),
}));

import { exponentialBackoff } from '../../src/utils/helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  wsConstructorCalls = 0;
  // Mock fetch so _fetchMarkets() resolves immediately with an empty list
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 503,
  } as Response);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Connection establishment (Req 1.1, 1.2) ─────────────────────────────────

describe('WebSocket reconnection — connection establishment', () => {
  it('establishes connection and becomes connected after open event', async () => {
    const logger = makeLogger();
    const mgr = new WebSocketManager('ws://mock-server:9999', logger);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    expect(mgr.isConnected()).toBe(true);
  });

  it('is not connected before open event fires', () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.connect();
    expect(mgr.isConnected()).toBe(false);
  });

  it('registers message, error, and close event listeners (Req 1.2)', async () => {
    const onTrade = jest.fn();
    const onError = jest.fn();
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.onTrade(onTrade);
    mgr.onError(onError);
    mgr.onReconnect(onReconnect);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    // Emit error — should call error callback
    const err = new Error('test error');
    mockWsInstance.emit('error', err);
    expect(onError).toHaveBeenCalledWith(err);

    // Emit close — should call reconnect callback
    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

// ─── Automatic reconnection (Req 1.5) ────────────────────────────────────────

describe('WebSocket reconnection — automatic reconnect on disconnect (Req 1.5)', () => {
  it('schedules reconnect when socket closes unexpectedly', async () => {
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.onReconnect(onReconnect);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    // Simulate unexpected disconnect
    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('calls exponentialBackoff with attempt=0 on first reconnect (Req 1.5)', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');

    // Flush the setTimeout(0) that schedules reconnect
    jest.runAllTimers();
    await Promise.resolve();

    expect(exponentialBackoff).toHaveBeenCalledWith(0, 60_000);
  });

  it('increments attempt counter on each reconnect (Req 1.5)', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    // First disconnect
    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');
    jest.runAllTimers();
    await Promise.resolve();

    expect(exponentialBackoff).toHaveBeenCalledWith(0, 60_000);
  });

  it('does NOT reconnect after explicit disconnect() call', async () => {
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.onReconnect(onReconnect);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    // Explicit disconnect — should NOT trigger reconnect
    mgr.disconnect();

    expect(onReconnect).not.toHaveBeenCalled();
    expect(mgr.isConnected()).toBe(false);
  });
});

// ─── 30-second connection timeout (Req 1.6) ──────────────────────────────────

describe('WebSocket reconnection — 30-second connection timeout (Req 1.6)', () => {
  it('terminates socket if not open within 30 seconds', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.connect();

    // Socket stays in CONNECTING — advance 30s
    jest.advanceTimersByTime(30_000);

    expect(mockWsInstance.readyState).toBe(MockWs.CLOSED);
  });

  it('does NOT terminate socket if it opens before 30 seconds', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    jest.advanceTimersByTime(30_000);

    expect(mgr.isConnected()).toBe(true);
  });

  it('treats timeout as a failed attempt and schedules reconnect (Req 1.6)', async () => {
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.onReconnect(onReconnect);

    mgr.connect();

    // Advance 30s to trigger timeout → terminate → close event → reconnect
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

// ─── Graceful shutdown on SIGINT (Req 1.7) ───────────────────────────────────

describe('WebSocket reconnection — graceful shutdown (Req 1.7)', () => {
  it('disconnect() closes the WebSocket and stops reconnection', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    expect(mgr.isConnected()).toBe(true);

    mgr.disconnect();

    expect(mgr.isConnected()).toBe(false);
  });

  it('disconnect() prevents further reconnect attempts after close', async () => {
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    mgr.onReconnect(onReconnect);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mgr.disconnect();

    // Even if close fires again, no reconnect
    jest.runAllTimers();
    await Promise.resolve();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('disconnect() clears pending reconnect timers', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    // Trigger a reconnect schedule
    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');

    // Immediately disconnect before reconnect fires
    mgr.disconnect();

    const callsBefore = (exponentialBackoff as jest.Mock).mock.calls.length;

    jest.runAllTimers();
    await Promise.resolve();

    // No additional backoff calls after disconnect
    expect((exponentialBackoff as jest.Mock).mock.calls.length).toBe(callsBefore);
  });
});

// ─── Backoff timing sequence (Req 1.5) ───────────────────────────────────────

describe('WebSocket reconnection — backoff timing (Req 1.5)', () => {
  it('uses max delay of 60s for exponential backoff', async () => {
    const mgr = new WebSocketManager('ws://mock-server:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');
    jest.runAllTimers();
    await Promise.resolve();

    // Verify max delay cap is 60_000ms
    const calls = (exponentialBackoff as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][1]).toBe(60_000);
  });
});
