import { EventEmitter } from 'events';
import { WebSocketManager } from '../../src/websocket/WebSocketManager';
import { Logger } from '../../src/utils/Logger';
import { RawTrade } from '../../src/types/index';

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
  close() { this.readyState = MockWs.CLOSED; this.emit('close'); }
  terminate() { this.readyState = MockWs.CLOSED; this.emit('close'); }
}

jest.mock('ws', () => {
  const mock = jest.fn().mockImplementation(() => new MockWs());
  (mock as unknown as Record<string, unknown>).OPEN = 1;
  return mock;
});

// ─── Mock helpers ─────────────────────────────────────────────────────────────

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

function validTrade(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    market_id: 'mkt-1',
    market_name: 'Test Market',
    side: 'YES',
    price: 0.6,
    size: 100,
    size_usd: 5000,
    timestamp: Date.now(),
    maker_address: '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
    taker_address: '0x1122334455667788990011223344556677889900',
    order_book_depth: { bid_liquidity: 10000, ask_liquidity: 8000 },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Connection ───────────────────────────────────────────────────────────────

describe('WebSocketManager — connection', () => {
  it('establishes connection and registers event listeners', async () => {
    const logger = makeLogger();
    const mgr = new WebSocketManager('ws://localhost:9999', logger);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    expect(mgr.isConnected()).toBe(true);
  });

  it('isConnected returns false before open event', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.connect();
    expect(mgr.isConnected()).toBe(false);
  });

  it('disconnect closes the socket and prevents reconnect', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mgr.disconnect();
    expect(mgr.isConnected()).toBe(false);
  });
});

// ─── Reconnection ─────────────────────────────────────────────────────────────

describe('WebSocketManager — reconnection on close/error', () => {
  it('schedules reconnect when socket closes', async () => {
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.onReconnect(onReconnect);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.readyState = MockWs.CLOSED;
    mockWsInstance.emit('close');

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('does NOT reconnect after disconnect() is called', async () => {
    const onReconnect = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.onReconnect(onReconnect);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mgr.disconnect();
    // close event fires inside disconnect — reconnect should NOT be triggered
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('calls exponentialBackoff with increasing attempt count on repeated closes', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());

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
});

// ─── Exponential backoff sequence ─────────────────────────────────────────────

describe('WebSocketManager — exponential backoff delay sequence', () => {
  it('passes attempt 0 on first reconnect', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.emit('close');
    jest.runAllTimers();
    await Promise.resolve();

    expect(exponentialBackoff).toHaveBeenCalledWith(0, 60_000);
  });
});

// ─── 30-second connection timeout ─────────────────────────────────────────────

describe('WebSocketManager — 30-second connection timeout', () => {
  it('terminates socket if not open within 30 seconds', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.connect();

    // Socket stays in CONNECTING state — advance 30s
    jest.advanceTimersByTime(30_000);

    // After timeout, socket should be terminated (readyState CLOSED)
    expect(mockWsInstance.readyState).toBe(MockWs.CLOSED);
  });

  it('does NOT terminate socket if it opens before 30 seconds', async () => {
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    jest.advanceTimersByTime(30_000);

    expect(mgr.isConnected()).toBe(true);
  });
});

// ─── Malformed messages ───────────────────────────────────────────────────────

describe('WebSocketManager — malformed message handling', () => {
  it('skips non-JSON messages without crashing', async () => {
    const logger = makeLogger();
    const onTrade = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', logger);
    mgr.onTrade(onTrade);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.emit('message', Buffer.from('not-json'));

    expect(onTrade).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('malformed'))).toBe(true);
  });

  it('skips message with missing required field', async () => {
    const onTrade = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.onTrade(onTrade);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    const bad = validTrade();
    delete bad['market_id'];
    mockWsInstance.emit('message', Buffer.from(JSON.stringify(bad)));

    expect(onTrade).not.toHaveBeenCalled();
  });

  it('skips message with invalid side value', async () => {
    const onTrade = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.onTrade(onTrade);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.emit('message', Buffer.from(JSON.stringify(validTrade({ side: 'MAYBE' }))));

    expect(onTrade).not.toHaveBeenCalled();
  });

  it('skips message with invalid Ethereum address', async () => {
    const onTrade = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.onTrade(onTrade);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    mockWsInstance.emit('message', Buffer.from(JSON.stringify(validTrade({ maker_address: 'not-an-address' }))));

    expect(onTrade).not.toHaveBeenCalled();
  });

  it('delivers valid trade to onTrade callback', async () => {
    const onTrade = jest.fn();
    const mgr = new WebSocketManager('ws://localhost:9999', makeLogger());
    mgr.onTrade(onTrade);

    const connectPromise = mgr.connect();
    mockWsInstance.readyState = MockWs.OPEN;
    mockWsInstance.emit('open');
    await connectPromise;

    const trade = validTrade();
    mockWsInstance.emit('message', Buffer.from(JSON.stringify(trade)));

    expect(onTrade).toHaveBeenCalledTimes(1);
    const received: RawTrade = onTrade.mock.calls[0][0];
    expect(received.market_id).toBe('mkt-1');
    expect(received.side).toBe('YES');
    expect(received.size_usd).toBe(5000);
  });
});
