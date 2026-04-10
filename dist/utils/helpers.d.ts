/**
 * Calculate the Z-score of a value given a mean and standard deviation.
 * Returns 0 when stddev is 0 to avoid division by zero.
 */
export declare function calculateZScore(value: number, mean: number, stddev: number): number;
/**
 * Delay execution using exponential backoff.
 * Delay = min(2^attempt * 1000, maxDelay) ms.
 */
export declare function exponentialBackoff(attempt: number, maxDelay: number): Promise<void>;
/**
 * Simple sleep helper.
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Escape Telegram MarkdownV1 special characters in a string.
 * Special chars: _ * ` [ ] ( ) ~ > # + - = | { } . !
 */
export declare function escapeMarkdown(text: string): string;
/**
 * Validate an Ethereum address: must be 0x followed by exactly 40 hex characters.
 */
export declare function isValidEthAddress(address: string): boolean;
//# sourceMappingURL=helpers.d.ts.map