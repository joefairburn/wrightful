import { and, asc, db, desc, eq, isNull, or, sql } from "void/db";
import { logger } from "void/log";
import { runs, testResults } from "@schema";
import type { GroupByAxis } from "@/lib/group-tests-by-file";
import { STATUS_BUCKET_MEMBERS, statusMatchSql } from "@/lib/ingest";
import { numericSql } from "@/lib/db/sql-ops";
import { escapeLike, likeEscaped } from "@/lib/runs-filters-where";
import type { StatusGroupKey } from "@/lib/status";
import { childByRunWhere, runByIdWhere, type TenantScope } from "@/lib/scope";

/** A non-null Drizzle SQL fragment (`void/db` doesn't export the `SQL` type). */
type SqlFragment = NonNullable<ReturnType<typeof and>>;

/**
 * Wire enums for the grouped read routes (`/groups` + `/results`), single-sourced
 * here so the two route validators can't drift. `satisfies` ties each to its
 * domain type (`GroupByAxis` / `StatusGroupKey`).
 */
export const GROUP_BY_AXES = [
  "file",
  "project",
  "shard",
] as const satisfies readonly GroupByAxis[];
export const STATUS_BUCKET_KEYS = [
  "failed",
  "flaky",
  "passed",
  "skipped",
] as const satisfies readonly StatusGroupKey[];

/**
 * A hard ceiling on how many group headers one skeleton read returns. Group
 * cardinality per run is small by design (~100 files / a few projects / tens of
 * shards), so this is a safety valve, not the common path — a run that trips it
 * is the signal to promote the on-the-fly aggregate to a materialized
 * per-(run, axis, groupKey) rollup (see the run-detail groups worklog). We log
 * rather than silently truncate so a real breach is visible.
 */
export const MAX_RUN_GROUPS = 500;

/** One group's header: the raw axis value + its 4-bucket counts, worst-first. */
export interface RunGroupHeader {
  /**
   * The raw grouping value for the active axis — `file` string, `projectName`
   * (nullable), or `shardIndex` as a decimal string (nullable). `null` is the
   * axis's fallback group (empty projectName / non-sharded rows); the client
   * renders it as "default"/"Unsharded" and the row query maps it back to the
   * `IS NULL` predicate. For `file` (a NOT NULL column) an empty path reads as
   * the empty string, never `null`.
   */
  key: string | null;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /**
   * Server-computed hint: this group is among the worst-N and carries a
   * failed/flaky-bucket test (or is the single worst group when none do), so
   * the client expands it on first paint. Boolean (not a key list) so the
   * `null` fallback group needs no special encoding on the wire.
   */
  expandedByDefault: boolean;
}

export interface RunGroupSkeleton {
  groupBy: GroupByAxis;
  /** Group headers, ordered worst-first (`failed*4 + flaky*2` desc, key asc). */
  groups: RunGroupHeader[];
  /** True when `MAX_RUN_GROUPS` clipped the result (see the constant). */
  truncated: boolean;
}

export interface LoadRunGroupsOpts {
  groupBy: GroupByAxis;
  /** Active status chip; `null`/`"all"` disables status filtering. */
  status: StatusGroupKey | null;
  /** Free-text needle matched against title + file (case-insensitive). */
  search: string | null;
  /**
   * Skip the explicit run-exists probe when the caller already resolved the run
   * (the SSR loader selects the run row first). API routes leave this false so a
   * foreign/missing run 404s. This does NOT relax tenant scoping — the aggregate
   * always filters by `childByRunWhere` (projectId + runId), so even with the
   * probe skipped a foreign runId yields zero rows, never another tenant's data;
   * the only effect is an empty result instead of a 404.
   */
  skipOwnershipCheck?: boolean;
}

/** How many of the worst groups auto-expand (matches the SSR-seeded default). */
const AUTO_EXPAND_WINDOW = 6;

/** The `testResults` column backing each group-by axis. */
export function groupAxisColumn(axis: GroupByAxis) {
  if (axis === "file") return testResults.file;
  if (axis === "project") return testResults.projectName;
  return testResults.shardIndex;
}

/**
 * The WHERE predicate that scopes a row query to one group. `key === null`
 * selects the axis's fallback group: `IS NULL` for the nullable `projectName`
 * / `shardIndex` axes, and the empty-string file for the NOT NULL `file` axis.
 * The inverse of the client's `rawGroupKey` (which produces the skeleton `key`).
 */
export function groupPredicate(
  axis: GroupByAxis,
  key: string | null,
): SqlFragment {
  if (axis === "shard") {
    if (key === null) return isNull(testResults.shardIndex);
    const n = Number(key);
    return Number.isInteger(n)
      ? eq(testResults.shardIndex, n)
      : isNull(testResults.shardIndex);
  }
  if (axis === "project") {
    return key === null
      ? isNull(testResults.projectName)
      : eq(testResults.projectName, key);
  }
  // file is NOT NULL — a null key is the empty-path group, never IS NULL.
  return eq(testResults.file, key ?? "");
}

/** `(title ILIKE %q% OR file ILIKE %q%)` with wildcard-escaped needle, or null. */
export function testSearchPredicate(search: string | null): SqlFragment | null {
  const term = search?.trim();
  if (!term) return null;
  const pattern = `%${escapeLike(term)}%`;
  return (
    or(
      likeEscaped(testResults.title, pattern),
      likeEscaped(testResults.file, pattern),
    ) ?? null
  );
}

/** The `count(*) FILTER (WHERE status IN <bucket>)` fragment for one bucket. */
function bucketCount(bucket: keyof typeof STATUS_BUCKET_MEMBERS) {
  return numericSql(
    sql`count(*) filter (where ${statusMatchSql(STATUS_BUCKET_MEMBERS[bucket])})`,
  );
}

/**
 * The "group skeleton" for a run's Tests tab: one worst-first-ordered header
 * per group (file / Playwright project / shard) with its 4-bucket counts,
 * computed by a single `GROUP BY <axis>` over the run's rows. The counts reuse
 * `STATUS_BUCKET_MEMBERS` / `statusMatchSql` verbatim so they can never drift
 * from the run-level aggregate (`aggregateRecomputeStatement`) the filter chips
 * read. Rides `testResults_project_runId_idx` (projectId, runId): the seek
 * narrows to one run's partition, then a HashAggregate collapses it to the
 * (small) group set — no group-column index needed at current scale.
 *
 * This is the read seam a materialized rollup would slot behind unchanged: same
 * signature, same `RunGroupSkeleton` shape.
 */
export async function loadRunGroupSkeleton(
  scope: TenantScope,
  runId: string,
  opts: LoadRunGroupsOpts,
): Promise<RunGroupSkeleton | null> {
  if (!opts.skipOwnershipCheck) {
    const owner = await db
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .limit(1);
    if (!owner[0]) return null;
  }

  const axisCol = groupAxisColumn(opts.groupBy);
  const conditions: SqlFragment[] = [
    childByRunWhere(testResults, scope, runId),
  ];
  if (opts.status) {
    conditions.push(statusMatchSql(STATUS_BUCKET_MEMBERS[opts.status]));
  }
  const search = testSearchPredicate(opts.search);
  if (search) conditions.push(search);

  // Worst-first group ordering, owned by the server: damage weight
  // failed*4 + flaky*2 (failed/flaky are the bucketed counts, so timedout ∈
  // failed), desc; the group key breaks ties (asc) for a stable, deterministic
  // order. This is the authoritative display order — the client renders the
  // skeleton verbatim, it does not re-sort groups.
  const severity = sql`count(*) filter (where ${statusMatchSql(
    STATUS_BUCKET_MEMBERS.failed,
  )}) * 4 + count(*) filter (where ${statusMatchSql(
    STATUS_BUCKET_MEMBERS.flaky,
  )}) * 2`;

  const rows = await db
    .select({
      key: axisCol,
      total: numericSql(sql`count(*)`),
      passed: bucketCount("passed"),
      failed: bucketCount("failed"),
      flaky: bucketCount("flaky"),
      skipped: bucketCount("skipped"),
    })
    .from(testResults)
    .where(and(...conditions))
    .groupBy(axisCol)
    .orderBy(desc(severity), asc(axisCol))
    .limit(MAX_RUN_GROUPS + 1);

  const truncated = rows.length > MAX_RUN_GROUPS;
  if (truncated) {
    logger.warn("run-group-skeleton truncated", {
      runId,
      groupBy: opts.groupBy,
      cap: MAX_RUN_GROUPS,
    });
  }
  const page = truncated ? rows.slice(0, MAX_RUN_GROUPS) : rows;

  // Auto-expand the worst-N groups that actually carry a failed/flaky test;
  // fall back to the single worst group so the list is never fully collapsed.
  // `page` is already worst-first. The client applies this on first paint (and,
  // for a run watched live from empty, waits for the first failed/flaky group
  // before latching — see `RunProgress`).
  const expandedIdx = new Set<number>();
  for (let i = 0; i < Math.min(AUTO_EXPAND_WINDOW, page.length); i++) {
    const r = page[i];
    if (r && (r.failed > 0 || r.flaky > 0)) expandedIdx.add(i);
  }
  if (expandedIdx.size === 0 && page.length > 0) expandedIdx.add(0);

  const groups: RunGroupHeader[] = page.map((r, i) => ({
    // Normalize the raw value to `string | null`: shardIndex is a number.
    key: r.key === null ? null : String(r.key),
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    flaky: r.flaky,
    skipped: r.skipped,
    expandedByDefault: expandedIdx.has(i),
  }));

  return { groupBy: opts.groupBy, groups, truncated };
}
