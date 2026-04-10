"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramNotifier = void 0;
const fs = __importStar(require("fs"));
const helpers_1 = require("../utils/helpers");
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_INTERVAL_MS = 34; // 30 msg/sec → ~34ms between sends
const FAILED_ALERTS_LOG = './failed-alerts.log';
class TelegramNotifier {
    constructor(config, logger) {
        this.lastSentAt = 0;
        this.config = config;
        this.logger = logger;
    }
    get baseUrl() {
        return `${TELEGRAM_API_BASE}${this.config.botToken}`;
    }
    /** Enforce 30 msg/sec rate limit by waiting if needed. */
    async throttle() {
        const now = Date.now();
        const elapsed = now - this.lastSentAt;
        if (elapsed < RATE_LIMIT_INTERVAL_MS) {
            await (0, helpers_1.sleep)(RATE_LIMIT_INTERVAL_MS - elapsed);
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
    async sendAlert(message) {
        await this.throttle();
        const body = {
            chat_id: this.config.chatId,
            text: message.text,
            parse_mode: message.parse_mode,
            disable_web_page_preview: message.disable_web_page_preview,
        };
        let lastError;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await (0, helpers_1.exponentialBackoff)(attempt, 10000);
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
            }
            catch (err) {
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
    async testConnection() {
        try {
            const response = await fetch(`${this.baseUrl}/getMe`);
            if (!response.ok) {
                this.logger.warn('Telegram getMe returned non-OK status', { status: response.status });
                return false;
            }
            return true;
        }
        catch (err) {
            this.logger.warn('Telegram testConnection failed', { error: String(err) });
            return false;
        }
    }
    /** Append failed alert details to the fallback log file. */
    writeFailedAlert(message, error) {
        const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            chatId: this.config.chatId,
            message,
            error: error instanceof Error ? error.message : String(error),
        });
        try {
            fs.appendFileSync(FAILED_ALERTS_LOG, entry + '\n', 'utf8');
        }
        catch (fsErr) {
            this.logger.error('Failed to write to failed-alerts.log', fsErr);
        }
    }
}
exports.TelegramNotifier = TelegramNotifier;
//# sourceMappingURL=TelegramNotifier.js.map