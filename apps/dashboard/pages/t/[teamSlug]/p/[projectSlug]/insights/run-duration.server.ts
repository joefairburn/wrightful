import { defineHandler, type InferProps } from "void";
import { db, sql } from "void/db";
import { parseBranchParam } from "@/components/run-history-branch-filter.shared";
import {
  DAY_SEC,
  parseSegment,
  SEGMENTS,
  type Segment,
} from "@/lib/analytics/bucketing";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import { branchFragment } from "@/lib/analytics/filters";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

type RangeKey = "7d" | "14d" | "30d" | "90d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d", "90d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "30d");

function defaultSegmentForRange(range: RangeKey): Segment {
  return range === "90d" ? "week" : "day";
}

export interface PerBucketDurationRow {
  bucket: number | string;
  cnt: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

export interface OverallDurationStats {
  cnt: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

/**
 * Run duration loader. Two CTE queries:
 *   - perBucket: discrete-percentile picks by bucket (p50/p90/p95).
 *   - overall: same picks across the entire window (KPI cards).
 *
 * Discrete percentile picker: `MIN(CASE WHEN rn = MAX(1, ROUND(cnt * q)) ...)`
 * — keeps the target rank in [1..cnt] so a single-run bucket still resolves.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const segment = parseSegment(
    url.searchParams.get("segment"),
    defaultSegmentForRange(range),
  );
  const branchParam = url.searchParams.get("branch");
  const branchFilter = parseBranchParam(branchParam);
  const rangeSec = rangeToSeconds(range);
  const days = rangeSec ? rangeSec / DAY_SEC : 30;

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - days * DAY_SEC;
  const expr = bucketExpr(segment);

  const branches = await loadProjectBranches(scope);
  const branchSql = branchFragment(branchFilter);

  const perBucketResult = await db.run(sql`
    with ranked as (
      select
        ${expr} as bucket,
        runs."durationMs" as duration,
        row_number() over (partition by ${expr} order by runs."durationMs") as rn,
        count(*) over (partition by ${expr}) as cnt
      from runs
      where runs."projectId" = ${project.id}
        and runs."durationMs" > 0
        and runs."createdAt" >= ${windowStartSec}
        ${branchSql}
    )
    select
      bucket,
      max(cnt) as cnt,
      min(case when rn = max(1, cast(round(cnt * 0.50) as integer)) then duration end) as p50,
      min(case when rn = max(1, cast(round(cnt * 0.90) as integer)) then duration end) as p90,
      min(case when rn = max(1, cast(round(cnt * 0.95) as integer)) then duration end) as p95
    from ranked
    group by bucket
  `);
  const perBucket = (perBucketResult.results as PerBucketDurationRow[]) ?? [];

  const overallResult = await db.run(sql`
    with ranked as (
      select
        runs."durationMs" as duration,
        row_number() over (order by runs."durationMs") as rn,
        count(*) over () as cnt
      from runs
      where runs."projectId" = ${project.id}
        and runs."durationMs" > 0
        and runs."createdAt" >= ${windowStartSec}
        ${branchSql}
    )
    select
      max(cnt) as cnt,
      min(case when rn = max(1, cast(round(cnt * 0.50) as integer)) then duration end) as p50,
      min(case when rn = max(1, cast(round(cnt * 0.90) as integer)) then duration end) as p90,
      min(case when rn = max(1, cast(round(cnt * 0.95) as integer)) then duration end) as p95
    from ranked
  `);
  const overall: OverallDurationStats = (overallResult.results?.[0] as
    | OverallDurationStats
    | undefined) ?? {
    cnt: 0,
    p50: null,
    p90: null,
    p95: null,
  };

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    range,
    segment,
    days,
    nowSec,
    windowStartSec,
    branchParam,
    branches,
    perBucket,
    overall,
    pathname: url.pathname,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES as readonly string[],
  };
});
