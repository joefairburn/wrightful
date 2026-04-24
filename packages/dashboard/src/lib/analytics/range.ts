import { DAY_SEC } from "./bucketing";

/**
 * Convert a range key into a window length in seconds, or `null` for
 * the "all time" sentinel.
 *
 * Accepted shapes:
 *   - `"7d"`, `"30d"`, `"90d"` etc. — integer + `d` suffix.
 *   - `"1y"`, `"2y"` — integer + `y` suffix (365 days per year).
 *   - `"all"` — returns `null`; caller should treat as "no lower bound".
 *
 * Returns `undefined` for unrecognized strings so callers can apply
 * their own fallback (usually via `makeRangeParser`).
 */
export function rangeToSeconds(r: string): number | null | undefined {
  if (r === "all") return null;
  const match = /^(\d+)([dy])$/.exec(r);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  return match[2] === "y" ? n * 365 * DAY_SEC : n * DAY_SEC;
}

/**
 * Build a typed parser for the subset of range keys a page supports.
 * Each page declares its allowed options and a fallback — the parser
 * narrows URL input to that union.
 */
export function makeRangeParser<T extends string>(
  valid: readonly T[],
  fallback: T,
): (value: string | null) => T {
  return (value) => {
    if (value === null) return fallback;
    // Linear scan rather than a Set lookup: avoids an `as T` cast and the
    // option list is always tiny (< 10 entries per page).
    for (const v of valid) if (v === value) return v;
    return fallback;
  };
}
