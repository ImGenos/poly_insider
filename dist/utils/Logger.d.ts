import { LogLevel } from '../types/index';
export declare class Logger {
    private readonly logLevel;
    private readonly logFilePath;
    private currentDateSuffix;
    private fileStream;
    private secretValues;
    constructor(logLevel: LogLevel, logFilePath?: string);
    private openFileStream;
    private rotateIfNeeded;
    private shouldLog;
    private formatEntry;
    private write;
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, error?: Error | unknown, metadata?: Record<string, unknown>): void;
    debug(message: string, metadata?: Record<string, unknown>): void;
    close(): void;
}
//# sourceMappingURL=Logger.d.ts.map