// Single source of truth for test/run status colours. Imported by pages
// (for StatusBadge + table links) and by the sparkline/chart components.
//
// "fallback" is used when an unexpected status string shows up — e.g. a new
// Playwright status we don't yet know about. Keeping it muted prevents the
// surprise from looking like a real failure.

export type Status =
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "timedout"
  | "interrupted";

export const STATUS_COLORS: Record<Status, string> = {
  passed: "#16a34a",
  failed: "#dc2626",
  timedout: "#dc2626",
  flaky: "#ea580c",
  skipped: "#9ca3af",
  interrupted: "#9333ea",
};

const FALLBACK_COLOR = "#6b7280";

function isStatus(s: string): s is Status {
  return s in STATUS_COLORS;
}

/** Returns the colour for a known status, falling back to a muted grey. */
export function statusColor(status: string): string {
  return isStatus(status) ? STATUS_COLORS[status] : FALLBACK_COLOR;
}
