import { formatDuration } from "@/lib/time-format";

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Strips a redundant ".0" from a fixed-point string (`"2.0"` -> `"2"`). */
function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Human file size: `0 B`, `1.5 KB`, `2 MB`, `1.2 GB`.
 *
 * Deliberately distinct from `lib/usage.ts`'s `formatBytes`: the trace
 * viewer mirrors devtools/official-viewer display conventions (`KB`,
 * trailing-zero trimmed), while the usage page reports binary units
 * (`KiB`). Don't consolidate without picking one convention for both.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${trimTrailingZero(value.toFixed(1))} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * Trace timestamps are fractional monotonic milliseconds — this rounds (and
 * floors at 0) before handing off to `formatDuration`, which renders sub-1s
 * values verbatim and would otherwise show `834.5999…ms`.
 */
export function formatTraceDuration(ms: number): string {
  return formatDuration(Math.max(0, Math.round(ms)));
}

/** Best-effort JSON pretty-print, gated on a content/mime type. Non-JSON and
 * unparsable-despite-the-type bodies pass through untouched. */
export function prettyPrintJson(text: string, contentType: string): string {
  if (!contentType.includes("json")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Offset from trace start, timeline-style: `+834ms`, `+1.2s`. Pass
 * `{ signed: false }` for the bare `834ms` form (Log/Console columns).
 */
export function formatTraceOffset(
  ms: number,
  startTime: number,
  { signed = true }: { signed?: boolean } = {},
): string {
  const offset = Math.max(0, ms - startTime);
  const value =
    offset < 1000
      ? `${Math.round(offset)}ms`
      : `${trimTrailingZero((offset / 1000).toFixed(1))}s`;
  return signed ? `+${value}` : value;
}
