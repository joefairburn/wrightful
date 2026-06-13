import { sql } from "void/db";
import { percentilePick } from "@/lib/analytics/bucketing-sql";
import { runRow, runRows } from "@/lib/db-run";
import type { TenantScope } from "@/lib/scope";

/**
 * Analytics SQL for the HTTP (uptime) monitor detail page — DB-bound (imports
 * `void/db`), so integration-only, not unit-tested. Two reads:
 *   - {@link httpResponseTimeBuckets}: per-hour p50/p95 response time over a
 *     window, for the response-time trend chart. Reuses `percentilePick` (the
 *     discrete-percentile idiom) over an hourly partition.
 *   - {@link httpUptimeWindows}: pass+degraded ("up") vs countable counts over
 *     24h / 7d / 30d, for real time-based uptime % (vs the count-based last-N
 *     window the `ExecStrip` uses).
 *
 * Both mirror `uptimeFromExecutions`'s rule — `pass` AND `degraded` are up;
 * `running`/`error` are excluded from the denominator (infra, not an outage).
 * Response time only counts executions that GOT a response (`statusCode` not
 * null), so a network-error/timeout fail (whose `durationMs` is the time-to-
 * failure) doesn't distort the latency trend.
 */

const DAY_SEC = 86_400;

export interface ResponseTimeBucketRow {
  /** Hour index = `createdAt / 3600` (integer). */
  bucket: number;
  cnt: number;
  p50: number | null;
  p95: number | null;
}

/**
 * Per-hour p50/p95 response time for a monitor over `[windowStartSec, now]`.
 * The hourly divisor is inlined as a raw SQL literal (NOT a bound param) for the
 * same D1 text-affinity reason `bucketExpr` inlines its day/week divisors.
 */
export function httpResponseTimeBuckets(opts: {
  scope: TenantScope;
  monitorId: string;
  windowStartSec: number;
}): Promise<ResponseTimeBucketRow[]> {
  return runRows<ResponseTimeBucketRow>(sql`
    with ranked as (
      select
        monitorExecutions."createdAt" / 3600 as bucket,
        monitorExecutions."durationMs" as duration,
        row_number() over (
          partition by monitorExecutions."createdAt" / 3600
          order by monitorExecutions."durationMs"
        ) as rn,
        count(*) over (
          partition by monitorExecutions."createdAt" / 3600
        ) as cnt
      from monitorExecutions
      where monitorExecutions."projectId" = ${opts.scope.projectId}
        and monitorExecutions."monitorId" = ${opts.monitorId}
        and monitorExecutions."statusCode" is not null
        and monitorExecutions."durationMs" is not null
        and monitorExecutions."createdAt" >= ${opts.windowStartSec}
    )
    select
      bucket,
      max(cnt) as cnt,
      ${percentilePick(0.5)} as p50,
      ${percentilePick(0.95)} as p95
    from ranked
    group by bucket
    order by bucket
  `);
}

export interface UptimeWindowCounts {
  up: number;
  countable: number;
}

interface RawUptimeRow {
  u1: number;
  c1: number;
  u7: number;
  c7: number;
  u30: number;
  c30: number;
}

/**
 * "Up" (pass+degraded) and countable (pass+degraded+fail) execution counts for
 * the 24h / 7d / 30d windows, in one pass over the 30-day slice. The page turns
 * each into a % (`up / countable`), or null when nothing is countable yet.
 */
export async function httpUptimeWindows(opts: {
  scope: TenantScope;
  monitorId: string;
  nowSec: number;
}): Promise<{
  d1: UptimeWindowCounts;
  d7: UptimeWindowCounts;
  d30: UptimeWindowCounts;
}> {
  const d1 = opts.nowSec - DAY_SEC;
  const d7 = opts.nowSec - 7 * DAY_SEC;
  const d30 = opts.nowSec - 30 * DAY_SEC;
  const row = await runRow<RawUptimeRow>(sql`
    select
      sum(case when monitorExecutions."createdAt" >= ${d1} and monitorExecutions.state in ('pass','degraded') then 1 else 0 end) as u1,
      sum(case when monitorExecutions."createdAt" >= ${d1} and monitorExecutions.state in ('pass','degraded','fail') then 1 else 0 end) as c1,
      sum(case when monitorExecutions."createdAt" >= ${d7} and monitorExecutions.state in ('pass','degraded') then 1 else 0 end) as u7,
      sum(case when monitorExecutions."createdAt" >= ${d7} and monitorExecutions.state in ('pass','degraded','fail') then 1 else 0 end) as c7,
      sum(case when monitorExecutions.state in ('pass','degraded') then 1 else 0 end) as u30,
      sum(case when monitorExecutions.state in ('pass','degraded','fail') then 1 else 0 end) as c30
    from monitorExecutions
    where monitorExecutions."projectId" = ${opts.scope.projectId}
      and monitorExecutions."monitorId" = ${opts.monitorId}
      and monitorExecutions."createdAt" >= ${d30}
  `);
  return {
    d1: { up: row?.u1 ?? 0, countable: row?.c1 ?? 0 },
    d7: { up: row?.u7 ?? 0, countable: row?.c7 ?? 0 },
    d30: { up: row?.u30 ?? 0, countable: row?.c30 ?? 0 },
  };
}
