import { sql } from "void/db";
import type { Segment } from "./bucketing";

/** Drizzle `SQL` fragment — the exact return type of `sql\`…\`` template literal. */
export type SqlBucketExpr = ReturnType<typeof sql<number | string>>;

/**
 * Bucket-expression for SQL aggregation. Returns a Drizzle `SQL` fragment
 * usable in `.select({ bucket: expr })` and `.groupBy(expr)`.
 *
 * Divisors are inlined as literals — D1's bound-parameter pipeline applies
 * text affinity to numeric params, which can silently turn integer division
 * into string concatenation. Matches the same pattern the rwsdk version
 * used against the DO-SQLite driver.
 */
export function bucketExpr(segment: Segment): SqlBucketExpr {
  if (segment === "day") return sql<number | string>`runs."createdAt" / 86400`;
  if (segment === "week")
    return sql<number | string>`runs."createdAt" / 604800`;
  return sql<number | string>`strftime('%Y-%m', runs."createdAt", 'unixepoch')`;
}
