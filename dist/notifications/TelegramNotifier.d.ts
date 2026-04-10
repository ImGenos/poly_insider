import { TelegramConfig, TelegramMessage } from '../types/index';
import { Logger } from '../utils/Logger';
export declare class TelegramNotifier {
    private readonly config;
    private readonly logger;
    private lastSentAt;
    constructor(config: TelegramConfig, logger: Logger);
    private get baseUrl();
    /** Enforce 30 msg/sec rate limit by waiting if needed. */
    private throttle;
    /**
     * Send an alert message to the configured Telegram chat.
     * Retries up to 3 attempts with exponential backoff.
     * On all retries exhausted, logs to failed-alerts.log without throwing.
     *
     * Requirements: 11.1, 11.2, 11.3, 11.5
     */
    sendAlert(message: TelegramMessage): Promise<void>;
    /**
     * Test the bot connection by calling the getMe endpoint.
     * Returns false on any failure instead of throwing.
     *
     * Requirements: 11.4
     */
    testConnection(): Promise<boolean>;
    /** Append failed alert details to the fallback log file. */
    private writeFailedAlert;
}
//# sourceMappingURL=TelegramNotifier.d.ts.map