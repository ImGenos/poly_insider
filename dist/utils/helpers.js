"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateZScore = calculateZScore;
exports.exponentialBackoff = exponentialBackoff;
exports.sleep = sleep;
exports.escapeMarkdown = escapeMarkdown;
exports.isValidEthAddress = isValidEthAddress;
/**
 * Calculate the Z-score of a value given a mean and standard deviation.
 * Returns 0 when stddev is 0 to avoid division by zero.
 */
function calculateZScore(value, mean, stddev) {
    if (stddev === 0)
        return 0;
    return (value - mean) / stddev;
}
/**
 * Delay execution using exponential backoff.
 * Delay = min(2^attempt * 1000, maxDelay) ms.
 */
function exponentialBackoff(attempt, maxDelay) {
    const delay = Math.min(Math.pow(2, attempt) * 1000, maxDelay);
    return sleep(delay);
}
/**
 * Simple sleep helper.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Escape Telegram MarkdownV1 special characters in a string.
 * Special chars: _ * ` [ ] ( ) ~ > # + - = | { } . !
 */
function escapeMarkdown(text) {
    return text.replace(/[_*`[\]()~>#+=|{}.!\-]/g, '\\$&');
}
/**
 * Validate an Ethereum address: must be 0x followed by exactly 40 hex characters.
 */
function isValidEthAddress(address) {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
}
//# sourceMappingURL=helpers.js.map