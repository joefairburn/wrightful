import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
} from "date-fns";

/** Human-readable duration: `450ms`, `12s`, `1m 3s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Short relative timestamp: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatRelativeTime(
  date: Date,
  now: number = Date.now(),
): string {
  const base = new Date(now);
  const minutes = differenceInMinutes(base, date);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = differenceInHours(base, date);
  if (hours < 24) return `${hours}h ago`;
  return `${differenceInDays(base, date)}d ago`;
}
