/**
 * Calculate the Z-score of a value given a mean and standard deviation.
 * Returns 0 when stddev is 0 to avoid division by zero.
 */
export function calculateZScore(value: number, mean: number, stddev: number): number {
  if (stddev === 0) return 0;
  return (value - mean) / stddev;
}

/**
 * Delay execution using exponential backoff.
 * Delay = min(2^attempt * 1000, maxDelay) ms.
 *
 * The attempt value is capped at 20 before computing the power to prevent
 * Math.pow(2, attempt) from producing astronomically large intermediate values.
 * 2^20 * 1000ms ≈ 17 minutes, which already exceeds any realistic maxDelay.
 */
export function exponentialBackoff(attempt: number, maxDelay: number): Promise<void> {
  const cappedAttempt = Math.min(attempt, 20);
  const delay = Math.min(Math.pow(2, cappedAttempt) * 1000, maxDelay);
  return sleep(delay);
}

/**
 * Simple sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Escape Telegram MarkdownV1 special characters in a string.
 * Special chars: _ * ` [ ] ( ) ~ > # + - = | { } . !
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[\]()~>#+=|{}.!\-]/g, '\\$&');
}

/**
 * Validate an Ethereum address: must be 0x followed by exactly 40 hex characters.
 */
export function isValidEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}
