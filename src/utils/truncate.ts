/**
 * Unified text truncation utility.
 *
 * Port of leadero/src/utils/truncate.ts (same semantics, same defaults) so
 * callers stop writing `slice(0, N) + '...'` inline.
 */

export interface TruncateOptions {
  /** Trailing marker for truncated text. Defaults to '...'. */
  suffix?: string;
  /** Preprocess input before length check and slicing (e.g. strip HTML tags). */
  transform?: (input: string) => string;
  /** Truncate from the end instead of the beginning. Prefix with suffix. */
  tail?: boolean;
}

/**
 * Truncate `text` to at most `maxLen` characters.
 *
 * - When `transform` is provided, the transformed string is sliced, but the
 *   short-circuit return value is the ORIGINAL text (preserving any formatting
 *   the caller may rely on).
 */
export function truncate(
  text: string,
  maxLen: number,
  options?: TruncateOptions,
): string {
  if (!text) return text;
  const processed = options?.transform ? options.transform(text) : text;
  if (processed.length <= maxLen) return text;
  if (options?.tail) {
    return (options?.suffix ?? '...') + processed.slice(-maxLen);
  }
  return processed.slice(0, maxLen) + (options?.suffix ?? '...');
}
