import * as fs from 'fs';
import { TelegramConfig, TelegramMessage } from '../types/index';
import { Logger } from '../utils/Logger';
import { exponentialBackoff, sleep } from '../utils/helpers';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_INTERVAL_MS = 34; // 30 msg/sec → ~34ms between sends
const FAILED_ALERTS_LOG = './failed-alerts.log';

export class TelegramNotifier {
  private readonly config: TelegramConfig;
  private readonly logger: Logger;
  private lastSentAt = 0;

  constructor(config: TelegramConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  private get baseUrl(): string {
    return `${TELEGRAM_API_BASE}${this.config.botToken}`;
  }

  /** Enforce 30 msg/sec rate limit by waiting if needed. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed < RATE_LIMIT_INTERVAL_MS) {
      await sleep(RATE_LIMIT_INTERVAL_MS - elapsed);
    }
    this.lastSentAt = Date.now();
  }

  /**
   * Send an alert message to the configured Telegram chat.
   * Retries up to 3 attempts with exponential backoff.
   * On all retries exhausted, logs to failed-alerts.log without throwing.
   *
   * Requirements: 11.1, 11.2, 11.3, 11.5
   */
  async sendAlert(message: TelegramMessage): Promise<void> {
    await this.throttle();

    const body = {
      chat_id: this.config.chatId,
      text: message.text,
      parse_mode: message.parse_mode,
      disable_web_page_preview: message.disable_web_page_preview,
    };

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await exponentialBackoff(attempt, 10_000);
      }

      try {
        const response = await fetch(`${this.baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          this.logger.info('Telegram alert sent', { attempt });
          return;
        }

        const errorText = await response.text().catch(() => '');
        lastError = new Error(`HTTP ${response.status}: ${errorText}`);
        this.logger.warn('Telegram sendMessage failed, will retry', {
          attempt,
          status: response.status,
        });
      } catch (err) {
        lastError = err;
        this.logger.warn('Telegram sendMessage error, will retry', { attempt, error: String(err) });
      }
    }

    // All retries exhausted — log to file, do NOT crash
    this.logger.error('Telegram alert failed after all retries, writing to failed-alerts.log', lastError);
    this.writeFailedAlert(message, lastError);
  }

  /**
   * Test the bot connection by calling the getMe endpoint.
   * Returns false on any failure instead of throwing.
   *
   * Requirements: 11.4
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/getMe`);
      if (!response.ok) {
        this.logger.warn('Telegram getMe returned non-OK status', { status: response.status });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn('Telegram testConnection failed', { error: String(err) });
      return false;
    }
  }

  /** Append failed alert details to the fallback log file. */
  private writeFailedAlert(message: TelegramMessage, error: unknown): void {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      chatId: this.config.chatId,
      message,
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      fs.appendFileSync(FAILED_ALERTS_LOG, entry + '\n', 'utf8');
    } catch (fsErr) {
      this.logger.error('Failed to write to failed-alerts.log', fsErr);
    }
  }
}
