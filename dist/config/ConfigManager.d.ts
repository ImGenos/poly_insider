import { DetectionThresholds, TelegramConfig, LogLevel } from '../types/index';
export declare class ConfigManager {
    private env;
    constructor();
    private validateRequired;
    private validateNumericThresholds;
    private parseNumber;
    private parseString;
    private parseList;
    getThresholds(): DetectionThresholds;
    getTelegramConfig(): TelegramConfig;
    getAlchemyApiKey(): string;
    getRedisUrl(): string;
    getTimescaleDbUrl(): string;
    getPolymarketWsUrl(): string;
    getAlertDedupTtl(): number;
    getClusterDedupTtl(): number;
    getLogLevel(): LogLevel;
    getLogFilePath(): string | undefined;
    getMoralisApiKey(): string | undefined;
    getKnownExchangeWallets(): string[];
}
//# sourceMappingURL=ConfigManager.d.ts.map