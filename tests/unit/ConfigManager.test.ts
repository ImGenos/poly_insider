import { ConfigManager } from '../../src/config/ConfigManager';

// Helper to set required env vars so ConfigManager doesn't exit
const REQUIRED_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_CHAT_ID: '123456789',
  ALCHEMY_API_KEY: 'test-alchemy-key',
  REDIS_URL: 'redis://localhost:6379',
  TIMESCALEDB_URL: 'postgresql://user:pass@localhost:5432/db',
  POLYMARKET_WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
};

function setRequiredEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, REQUIRED_ENV, overrides);
}

function clearEnv(): void {
  const allKeys = [
    ...Object.keys(REQUIRED_ENV),
    'MIN_TRADE_SIZE_USDC',
    'RAPID_ODDS_SHIFT_PERCENT',
    'RAPID_ODDS_SHIFT_WINDOW_MINUTES',
    'WHALE_ACTIVITY_PERCENT',
    'INSIDER_WALLET_AGE_HOURS',
    'INSIDER_MIN_TRADE_SIZE',
    'CLUSTER_WINDOW_MINUTES',
    'CLUSTER_MIN_WALLETS',
    'ZSCORE_THRESHOLD',
    'ZSCORE_MIN_SAMPLES',
    'ZSCORE_BASELINE_WINDOW',
    'ALERT_DEDUP_TTL_SECONDS',
    'CLUSTER_DEDUP_TTL_SECONDS',
    'NICHE_MARKET_CATEGORIES',
    'KNOWN_EXCHANGE_WALLETS',
    'LOG_LEVEL',
    'LOG_FILE_PATH',
    'MORALIS_API_KEY',
  ];
  allKeys.forEach((k) => delete process.env[k]);
}

beforeEach(() => {
  clearEnv();
});

afterEach(() => {
  clearEnv();
  jest.restoreAllMocks();
});

describe('ConfigManager — default values', () => {
  it('returns all default thresholds when env vars are absent', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    const t = cfg.getThresholds();

    expect(t.minTradeSizeUSDC).toBe(5000);
    expect(t.rapidOddsShiftPercent).toBe(15);
    expect(t.rapidOddsShiftWindowMinutes).toBe(5);
    expect(t.whaleActivityPercent).toBe(20);
    expect(t.insiderWalletAgeHours).toBe(48);
    expect(t.insiderMinTradeSize).toBe(10000);
    expect(t.clusterWindowMinutes).toBe(10);
    expect(t.clusterMinWallets).toBe(3);
    expect(t.zScoreThreshold).toBe(3.0);
    expect(t.zScoreMinSamples).toBe(30);
    expect(t.zScoreBaselineWindow).toBe(100);
  });

  it('returns default niche market categories', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    expect(cfg.getThresholds().nicheMarketCategories).toEqual(['sports', 'crypto']);
  });

  it('returns default alert dedup TTL of 3600', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    expect(cfg.getAlertDedupTtl()).toBe(3600);
  });

  it('returns default cluster dedup TTL of 600', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    expect(cfg.getClusterDedupTtl()).toBe(600);
  });

  it('returns default log level of info', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    expect(cfg.getLogLevel()).toBe('info');
  });

  it('returns undefined for optional LOG_FILE_PATH when not set', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    expect(cfg.getLogFilePath()).toBeUndefined();
  });

  it('returns empty array for KNOWN_EXCHANGE_WALLETS when not set', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();
    expect(cfg.getKnownExchangeWallets()).toEqual([]);
  });
});

describe('ConfigManager — env var overrides', () => {
  it('reads numeric thresholds from env vars', () => {
    setRequiredEnv({
      MIN_TRADE_SIZE_USDC: '1000',
      RAPID_ODDS_SHIFT_PERCENT: '10',
      WHALE_ACTIVITY_PERCENT: '30',
      CLUSTER_MIN_WALLETS: '5',
      ZSCORE_THRESHOLD: '2.5',
    });
    const cfg = new ConfigManager();
    const t = cfg.getThresholds();

    expect(t.minTradeSizeUSDC).toBe(1000);
    expect(t.rapidOddsShiftPercent).toBe(10);
    expect(t.whaleActivityPercent).toBe(30);
    expect(t.clusterMinWallets).toBe(5);
    expect(t.zScoreThreshold).toBe(2.5);
  });

  it('returns configured log level', () => {
    setRequiredEnv({ LOG_LEVEL: 'debug' });
    const cfg = new ConfigManager();
    expect(cfg.getLogLevel()).toBe('debug');
  });

  it('returns configured log file path', () => {
    setRequiredEnv({ LOG_FILE_PATH: '/var/log/bot.log' });
    const cfg = new ConfigManager();
    expect(cfg.getLogFilePath()).toBe('/var/log/bot.log');
  });

  it('falls back to info for invalid LOG_LEVEL', () => {
    setRequiredEnv({ LOG_LEVEL: 'verbose' });
    const cfg = new ConfigManager();
    expect(cfg.getLogLevel()).toBe('info');
  });
});

describe('ConfigManager — CSV parsing', () => {
  it('parses NICHE_MARKET_CATEGORIES as comma-separated list', () => {
    setRequiredEnv({ NICHE_MARKET_CATEGORIES: 'sports,crypto,politics' });
    const cfg = new ConfigManager();
    expect(cfg.getThresholds().nicheMarketCategories).toEqual(['sports', 'crypto', 'politics']);
  });

  it('trims whitespace from NICHE_MARKET_CATEGORIES entries', () => {
    setRequiredEnv({ NICHE_MARKET_CATEGORIES: ' sports , crypto , politics ' });
    const cfg = new ConfigManager();
    expect(cfg.getThresholds().nicheMarketCategories).toEqual(['sports', 'crypto', 'politics']);
  });

  it('parses KNOWN_EXCHANGE_WALLETS as comma-separated lowercase addresses', () => {
    setRequiredEnv({
      KNOWN_EXCHANGE_WALLETS: '0xABC123,0xDEF456',
    });
    const cfg = new ConfigManager();
    expect(cfg.getKnownExchangeWallets()).toEqual(['0xabc123', '0xdef456']);
  });

  it('trims whitespace from KNOWN_EXCHANGE_WALLETS entries', () => {
    setRequiredEnv({ KNOWN_EXCHANGE_WALLETS: ' 0xABC , 0xDEF ' });
    const cfg = new ConfigManager();
    expect(cfg.getKnownExchangeWallets()).toEqual(['0xabc', '0xdef']);
  });

  it('filters empty entries from CSV lists', () => {
    setRequiredEnv({ NICHE_MARKET_CATEGORIES: 'sports,,crypto,' });
    const cfg = new ConfigManager();
    expect(cfg.getThresholds().nicheMarketCategories).toEqual(['sports', 'crypto']);
  });
});

describe('ConfigManager — required var validation', () => {
  it('exits with code 1 when TELEGRAM_BOT_TOKEN is missing', () => {
    setRequiredEnv();
    delete process.env['TELEGRAM_BOT_TOKEN'];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when ALCHEMY_API_KEY is missing', () => {
    setRequiredEnv();
    delete process.env['ALCHEMY_API_KEY'];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when REDIS_URL is missing', () => {
    setRequiredEnv();
    delete process.env['REDIS_URL'];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when POLYMARKET_WS_URL is missing', () => {
    setRequiredEnv();
    delete process.env['POLYMARKET_WS_URL'];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when a required var is set to empty string', () => {
    setRequiredEnv({ TELEGRAM_CHAT_ID: '   ' });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('returns correct values for all required vars when set', () => {
    setRequiredEnv();
    const cfg = new ConfigManager();

    expect(cfg.getTelegramConfig()).toEqual({
      botToken: 'test-bot-token',
      chatId: '123456789',
    });
    expect(cfg.getAlchemyApiKey()).toBe('test-alchemy-key');
    expect(cfg.getRedisUrl()).toBe('redis://localhost:6379');
    expect(cfg.getTimescaleDbUrl()).toBe('postgresql://user:pass@localhost:5432/db');
  });
});

describe('ConfigManager — numeric threshold validation', () => {
  it('exits with code 1 when a numeric threshold is zero', () => {
    setRequiredEnv({ MIN_TRADE_SIZE_USDC: '0' });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when a numeric threshold is negative', () => {
    setRequiredEnv({ RAPID_ODDS_SHIFT_PERCENT: '-5' });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when a numeric threshold is NaN', () => {
    setRequiredEnv({ ZSCORE_THRESHOLD: 'not-a-number' });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when CLUSTER_MIN_WALLETS is 1 (< 2)', () => {
    setRequiredEnv({ CLUSTER_MIN_WALLETS: '1' });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => new ConfigManager()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts CLUSTER_MIN_WALLETS of exactly 2', () => {
    setRequiredEnv({ CLUSTER_MIN_WALLETS: '2' });
    const cfg = new ConfigManager();
    expect(cfg.getThresholds().clusterMinWallets).toBe(2);
  });
});
