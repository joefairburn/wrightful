const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Strips a redundant ".0" from a fixed-point string (`"2.0"` -> `"2"`). */
function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/** Human file size: `0 B`, `1.5 KB`, `2 MB`, `1.2 GB`. */
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

/** Offset from trace start, timeline-style: `+834ms`, `+1.2s`. */
export function formatTraceOffset(ms: number, startTime: number): string {
  const offset = Math.max(0, ms - startTime);
  if (offset < 1000) return `+${Math.round(offset)}ms`;
  return `+${trimTrailingZero((offset / 1000).toFixed(1))}s`;
}
