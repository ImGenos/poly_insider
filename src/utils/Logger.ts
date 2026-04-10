import * as fs from 'fs';
import * as path from 'path';
import { LogLevel } from '../types/index';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Env var names whose values should be redacted
const SECRET_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'ALCHEMY_API_KEY',
  'MORALIS_API_KEY',
  'TIMESCALEDB_URL',
];

function buildSecretValues(): string[] {
  return SECRET_ENV_VARS
    .map(name => process.env[name])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function redact(text: string, secretValues: string[]): string {
  let result = text;

  // Redact known secret env var values first (most precise)
  for (const secret of secretValues) {
    result = result.split(secret).join('[REDACTED]');
  }

  // Redact connection strings with passwords
  result = result.replace(/([a-z]+:\/\/[^:]+:)[^@]+(@)/g, '$1[REDACTED]$2');

  return result;
}

function getDateSuffix(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class Logger {
  private readonly logLevel: LogLevel;
  private readonly logFilePath: string | undefined;
  private currentDateSuffix: string;
  private nextRotateAt: number;
  private fileStream: fs.WriteStream | null = null;
  private secretValues: string[];

  constructor(logLevel: LogLevel, logFilePath?: string) {
    this.logLevel = logLevel;
    this.logFilePath = logFilePath;
    this.currentDateSuffix = getDateSuffix();
    this.nextRotateAt = Logger.nextMidnight();
    this.secretValues = buildSecretValues();

    if (this.logFilePath) {
      this.openFileStream();
    }
  }

  private static nextMidnight(): number {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  private openFileStream(): void {
    if (!this.logFilePath) return;

    const ext = path.extname(this.logFilePath);
    const base = this.logFilePath.slice(0, this.logFilePath.length - ext.length);
    const rotatedPath = `${base}-${this.currentDateSuffix}${ext || '.log'}`;

    const dir = path.dirname(rotatedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (this.fileStream) {
      this.fileStream.end();
    }

    this.fileStream = fs.createWriteStream(rotatedPath, { flags: 'a' });
    this.fileStream.on('error', (err: NodeJS.ErrnoException) => {
      process.stderr.write(`[Logger] File stream error (${err.code ?? err.message}): ${rotatedPath}\n`);
    });
  }

  private rotateIfNeeded(): void {
    if (Date.now() < this.nextRotateAt) return;
    this.currentDateSuffix = getDateSuffix();
    this.nextRotateAt = Logger.nextMidnight();
    this.openFileStream();
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.logLevel];
  }

  private formatEntry(level: LogLevel, message: string, metadata?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    let entry = `[${timestamp}] [${levelStr}] ${message}`;
    if (metadata && Object.keys(metadata).length > 0) {
      entry += ` ${JSON.stringify(metadata)}`;
    }
    return entry;
  }

  private write(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    this.rotateIfNeeded();

    // Refresh secret values in case env changed (e.g., in tests)
    this.secretValues = buildSecretValues();

    const rawEntry = this.formatEntry(level, message, metadata);
    const safeEntry = redact(rawEntry, this.secretValues);

    // Console output
    if (level === 'error' || level === 'warn') {
      process.stderr.write(safeEntry + '\n');
    } else {
      process.stdout.write(safeEntry + '\n');
    }

    // File output
    if (this.fileStream) {
      this.fileStream.write(safeEntry + '\n');
    }
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.write('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.write('warn', message, metadata);
  }

  error(message: string, error?: Error | unknown, metadata?: Record<string, unknown>): void {
    const meta: Record<string, unknown> = { ...metadata };
    if (error instanceof Error) {
      meta.error = { message: error.message, stack: error.stack };
    } else if (error !== undefined) {
      meta.error = error;
    }
    this.write('error', message, Object.keys(meta).length > 0 ? meta : undefined);
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.write('debug', message, metadata);
  }

  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}
