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
exports.Logger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const LOG_LEVEL_PRIORITY = {
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
function buildSecretValues() {
    return SECRET_ENV_VARS
        .map(name => process.env[name])
        .filter((v) => typeof v === 'string' && v.length > 0);
}
function redact(text, secretValues) {
    let result = text;
    // Redact known secret env var values first (most precise)
    for (const secret of secretValues) {
        result = result.split(secret).join('[REDACTED]');
    }
    // Redact connection strings with passwords
    result = result.replace(/([a-z]+:\/\/[^:]+:)[^@]+(@)/g, '$1[REDACTED]$2');
    return result;
}
function getDateSuffix() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
class Logger {
    constructor(logLevel, logFilePath) {
        this.fileStream = null;
        this.logLevel = logLevel;
        this.logFilePath = logFilePath;
        this.currentDateSuffix = getDateSuffix();
        this.secretValues = buildSecretValues();
        if (this.logFilePath) {
            this.openFileStream();
        }
    }
    openFileStream() {
        if (!this.logFilePath)
            return;
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
    }
    rotateIfNeeded() {
        const today = getDateSuffix();
        if (today !== this.currentDateSuffix) {
            this.currentDateSuffix = today;
            this.openFileStream();
        }
    }
    shouldLog(level) {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.logLevel];
    }
    formatEntry(level, message, metadata) {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        let entry = `[${timestamp}] [${levelStr}] ${message}`;
        if (metadata && Object.keys(metadata).length > 0) {
            entry += ` ${JSON.stringify(metadata)}`;
        }
        return entry;
    }
    write(level, message, metadata) {
        if (!this.shouldLog(level))
            return;
        this.rotateIfNeeded();
        // Refresh secret values in case env changed (e.g., in tests)
        this.secretValues = buildSecretValues();
        const rawEntry = this.formatEntry(level, message, metadata);
        const safeEntry = redact(rawEntry, this.secretValues);
        // Console output
        if (level === 'error' || level === 'warn') {
            process.stderr.write(safeEntry + '\n');
        }
        else {
            process.stdout.write(safeEntry + '\n');
        }
        // File output
        if (this.fileStream) {
            this.fileStream.write(safeEntry + '\n');
        }
    }
    info(message, metadata) {
        this.write('info', message, metadata);
    }
    warn(message, metadata) {
        this.write('warn', message, metadata);
    }
    error(message, error, metadata) {
        const meta = { ...metadata };
        if (error instanceof Error) {
            meta.error = { message: error.message, stack: error.stack };
        }
        else if (error !== undefined) {
            meta.error = error;
        }
        this.write('error', message, Object.keys(meta).length > 0 ? meta : undefined);
    }
    debug(message, metadata) {
        this.write('debug', message, metadata);
    }
    close() {
        if (this.fileStream) {
            this.fileStream.end();
            this.fileStream = null;
        }
    }
}
exports.Logger = Logger;
//# sourceMappingURL=Logger.js.map