import {
  DetectionThresholds,
  TelegramConfig,
  LogLevel,
} from '../types/index';

export class ConfigManager {
  private env: NodeJS.ProcessEnv;

  constructor() {
    this.env = process.env;
    this.validateRequired();
    this.validateNumericThresholds();
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  private validateRequired(): void {
    const required = [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'ALCHEMY_API_KEY',
      'REDIS_URL',
      'TIMESCALEDB_URL',
      'POLYMARKET_WS_URL',
    ];

    const missing = required.filter((key) => !this.env[key]?.trim());

    if (missing.length > 0) {
      console.error(
        `[ConfigManager] Missing required environment variables: ${missing.join(', ')}. ` +
          'Please set them in your .env file or environment before starting the bot.'
      );
      process.exit(1);
    }
  }

  private validateNumericThresholds(): void {
    const numericKeys: Array<{ key: string; default: number }> = [
      { key: 'MIN_TRADE_SIZE_USDC', default: 5000 },
      { key: 'RAPID_ODDS_SHIFT_PERCENT', default: 15 },
      { key: 'RAPID_ODDS_SHIFT_WINDOW_MINUTES', default: 5 },
      { key: 'WHALE_ACTIVITY_PERCENT', default: 20 },
      { key: 'INSIDER_WALLET_AGE_HOURS', default: 48 },
      { key: 'INSIDER_MIN_TRADE_SIZE', default: 10000 },
      { key: 'CLUSTER_WINDOW_MINUTES', default: 10 },
      { key: 'ZSCORE_THRESHOLD', default: 3.0 },
      { key: 'ZSCORE_MIN_SAMPLES', default: 30 },
      { key: 'ZSCORE_BASELINE_WINDOW', default: 100 },
      { key: 'ALERT_DEDUP_TTL_SECONDS', default: 3600 },
      { key: 'CLUSTER_DEDUP_TTL_SECONDS', default: 600 },
    ];

    const errors: string[] = [];

    for (const { key, default: defaultVal } of numericKeys) {
      const raw = this.env[key];
      const value = raw !== undefined ? parseFloat(raw) : defaultVal;

      if (isNaN(value) || value <= 0) {
        errors.push(`${key} must be a positive number (got: ${raw})`);
      }
    }

    const clusterMinWallets = this.parseNumber('CLUSTER_MIN_WALLETS', 3);
    if (clusterMinWallets < 2) {
      errors.push(`CLUSTER_MIN_WALLETS must be >= 2 (got: ${clusterMinWallets})`);
    }

    if (errors.length > 0) {
      console.error(
        `[ConfigManager] Invalid numeric threshold configuration:\n  - ${errors.join('\n  - ')}`
      );
      process.exit(1);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private parseNumber(key: string, defaultValue: number): number {
    const raw = this.env[key];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  private parseString(key: string, defaultValue: string): string {
    const raw = this.env[key];
    return raw?.trim() || defaultValue;
  }

  private parseList(key: string, defaultValue: string[]): string[] {
    const raw = this.env[key];
    if (!raw?.trim()) return defaultValue;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getThresholds(): DetectionThresholds {
    return {
      minTradeSizeUSDC: this.parseNumber('MIN_TRADE_SIZE_USDC', 5000),
      rapidOddsShiftPercent: this.parseNumber('RAPID_ODDS_SHIFT_PERCENT', 15),
      rapidOddsShiftWindowMinutes: this.parseNumber('RAPID_ODDS_SHIFT_WINDOW_MINUTES', 5),
      whaleActivityPercent: this.parseNumber('WHALE_ACTIVITY_PERCENT', 20),
      insiderWalletAgeHours: this.parseNumber('INSIDER_WALLET_AGE_HOURS', 48),
      insiderMinTradeSize: this.parseNumber('INSIDER_MIN_TRADE_SIZE', 10000),
      nicheMarketCategories: this.parseList('NICHE_MARKET_CATEGORIES', ['sports', 'crypto']),
      clusterWindowMinutes: this.parseNumber('CLUSTER_WINDOW_MINUTES', 10),
      clusterMinWallets: this.parseNumber('CLUSTER_MIN_WALLETS', 3),
      zScoreThreshold: this.parseNumber('ZSCORE_THRESHOLD', 3.0),
      zScoreMinSamples: this.parseNumber('ZSCORE_MIN_SAMPLES', 30),
      zScoreBaselineWindow: this.parseNumber('ZSCORE_BASELINE_WINDOW', 100),
    };
  }

  getTelegramConfig(): TelegramConfig {
    return {
      botToken: this.env['TELEGRAM_BOT_TOKEN']!,
      chatId: this.env['TELEGRAM_CHAT_ID']!,
    };
  }

  getAlchemyApiKey(): string {
    return this.env['ALCHEMY_API_KEY']!;
  }

  getRedisUrl(): string {
    return this.env['REDIS_URL']!;
  }

  getTimescaleDbUrl(): string {
    return this.env['TIMESCALEDB_URL']!;
  }

  getPolymarketWsUrl(): string {
    return this.env['POLYMARKET_WS_URL']!;
  }

  getAlertDedupTtl(): number {
    return this.parseNumber('ALERT_DEDUP_TTL_SECONDS', 3600);
  }

  getClusterDedupTtl(): number {
    return this.parseNumber('CLUSTER_DEDUP_TTL_SECONDS', 600);
  }

  getLogLevel(): LogLevel {
    const raw = this.parseString('LOG_LEVEL', 'info').toLowerCase();
    const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return valid.includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
  }

  getLogFilePath(): string | undefined {
    const raw = this.env['LOG_FILE_PATH']?.trim();
    return raw || undefined;
  }

  getMoralisApiKey(): string | undefined {
    const raw = this.env['MORALIS_API_KEY']?.trim();
    return raw || undefined;
  }

  getKnownExchangeWallets(): string[] {
    return this.parseList('KNOWN_EXCHANGE_WALLETS', []).map((w) => w.toLowerCase());
  }
}
