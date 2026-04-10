import * as helpers from '../../src/utils/helpers';
import { TelegramNotifier } from '../../src/notifications/TelegramNotifier';
import { TelegramConfig, TelegramMessage } from '../../src/types/index';
import { Logger } from '../../src/utils/Logger';

// Mock the entire 'fs' module so appendFileSync is a jest.fn()
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  appendFileSync: jest.fn(),
}));

// Import after mock so we get the mocked version
import * as fs from 'fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const config: TelegramConfig = { botToken: 'test-token', chatId: '12345' };

function makeLogger(): Logger {
  return new Logger('error'); // suppress output during tests
}

function makeMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    text: 'Test alert',
    parse_mode: 'Markdown',
    disable_web_page_preview: false,
    ...overrides,
  };
}

function makeOkResponse(body = '{}'): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeErrorResponse(status = 500): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve('Internal Server Error'),
  } as unknown as Response;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let fetchSpy: jest.SpyInstance;
let backoffSpy: jest.SpyInstance;

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch');
  backoffSpy = jest.spyOn(helpers, 'exponentialBackoff').mockResolvedValue(undefined);
  jest.spyOn(helpers, 'sleep').mockResolvedValue(undefined);
  (fs.appendFileSync as jest.Mock).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Successful send ──────────────────────────────────────────────────────────

describe('sendAlert – successful send (Req 11.2)', () => {
  it('calls fetch once with correct URL and body on success', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse());

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toBe('Test alert');
    expect(body.parse_mode).toBe('Markdown');
    expect(body.disable_web_page_preview).toBe(false);
  });

  it('does not write to failed-alerts.log on success', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse());

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });
});

// ─── Retry logic ──────────────────────────────────────────────────────────────

describe('sendAlert – retry logic (Req 11.2)', () => {
  it('retries up to 3 attempts and succeeds on the third', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse());

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('calls exponentialBackoff between retries (not before first attempt)', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse());

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    // exponentialBackoff called for attempt 1 and 2 (not 0)
    expect(backoffSpy).toHaveBeenCalledTimes(2);
    expect(backoffSpy).toHaveBeenCalledWith(1, 10_000);
    expect(backoffSpy).toHaveBeenCalledWith(2, 10_000);
  });

  it('does not write to failed-alerts.log when retry eventually succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse());

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });
});

// ─── File-system fallback ─────────────────────────────────────────────────────

describe('sendAlert – file-system fallback when all retries fail (Req 11.5)', () => {
  it('writes to failed-alerts.log after all 3 attempts fail', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(500));

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not throw when all retries fail', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(500));

    const notifier = new TelegramNotifier(config, makeLogger());
    await expect(notifier.sendAlert(makeMessage())).resolves.toBeUndefined();
  });

  it('fallback log entry contains message text and chatId', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(500));

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage({ text: 'Critical alert!' }));

    const written = (fs.appendFileSync as jest.Mock).mock.calls[0][1] as string;
    const entry = JSON.parse(written.trim());
    expect(entry.chatId).toBe('12345');
    expect(entry.message.text).toBe('Critical alert!');
  });

  it('also falls back when fetch throws a network error', async () => {
    fetchSpy.mockRejectedValue(new Error('Network failure'));

    const notifier = new TelegramNotifier(config, makeLogger());
    await notifier.sendAlert(makeMessage());

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });
});

// ─── testConnection ───────────────────────────────────────────────────────────

describe('testConnection (Req 11.4)', () => {
  it('returns true when getMe responds with ok status', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse('{"ok":true}'));

    const notifier = new TelegramNotifier(config, makeLogger());
    const result = await notifier.testConnection();

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/getMe',
    );
  });

  it('returns false when getMe responds with non-OK status', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(401));

    const notifier = new TelegramNotifier(config, makeLogger());
    const result = await notifier.testConnection();

    expect(result).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

    const notifier = new TelegramNotifier(config, makeLogger());
    const result = await notifier.testConnection();

    expect(result).toBe(false);
  });

  it('does not throw on API error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Timeout'));

    const notifier = new TelegramNotifier(config, makeLogger());
    await expect(notifier.testConnection()).resolves.toBe(false);
  });
});
