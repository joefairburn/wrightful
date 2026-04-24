import { type RawBuilder, sql } from "kysely";

export type Segment = "day" | "week" | "month";

export const SEGMENTS: readonly Segment[] = ["day", "week", "month"];

export const DAY_SEC = 86_400;
export const WEEK_SEC = 604_800;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dayLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function monthLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

export function parseSegment(value: string | null, fallback: Segment): Segment {
  return value === "day" || value === "week" || value === "month"
    ? value
    : fallback;
}

/**
 * Bucket-expression for SQL aggregation. Returns a kysely `RawBuilder`
 * that can be used in both `.select(expr.as("bucket"))` and
 * `.groupBy(expr)`.
 *
 * Divisors are inlined as literals, not interpolated via `${…}` — the
 * DO-SQLite driver applies text affinity when binding integer params,
 * which silently turns `createdAt / 86400` into string concatenation
 * and returns zero buckets. See worklog 2026-04-24 for the debug story.
 */
export function bucketExpr(segment: Segment): RawBuilder<number | string> {
  if (segment === "day") return sql`runs."createdAt" / 86400`;
  if (segment === "week") return sql`runs."createdAt" / 604800`;
  return sql`strftime('%Y-%m', runs."createdAt", 'unixepoch')`;
}

/**
 * Build the empty skeleton of buckets covering [windowStartSec, nowSec].
 *
 * Day/week buckets are integer divisions of unix seconds — week buckets
 * happen to anchor to Thursdays (epoch day 0 was a Thursday) but we
 * display each bucket's start date rather than a week number so the
 * anchor is invisible to readers.
 *
 * Month buckets use calendar alignment (strftime("%Y-%m") in SQL,
 * matching `${year}-${pad2(month)}` here).
 *
 * Keys are always strings so lookups against the SQL-returned rows work
 * uniformly regardless of which segment is active.
 */
export function buildEmptyBuckets(
  segment: Segment,
  windowStartSec: number,
  nowSec: number,
): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  if (segment === "day") {
    const first = Math.floor(windowStartSec / DAY_SEC);
    const last = Math.floor(nowSec / DAY_SEC);
    for (let i = first; i <= last; i++) {
      out.push({
        key: String(i),
        label: dayLabel(new Date(i * DAY_SEC * 1000)),
      });
    }
    return out;
  }
  if (segment === "week") {
    const first = Math.floor(windowStartSec / WEEK_SEC);
    const last = Math.floor(nowSec / WEEK_SEC);
    for (let i = first; i <= last; i++) {
      out.push({
        key: String(i),
        label: dayLabel(new Date(i * WEEK_SEC * 1000)),
      });
    }
    return out;
  }
  const start = new Date(windowStartSec * 1000);
  const end = new Date(nowSec * 1000);
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
  );
  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    out.push({ key: `${y}-${pad2(m)}`, label: monthLabel(cursor) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Normalize a bucket value from a SQL row to the string form produced
 * by `buildEmptyBuckets`. Day/week come back as JS numbers from the
 * integer division; month as a "YYYY-MM" string.
 */
export function bucketKey(v: number | string): string {
  return String(v);
}
