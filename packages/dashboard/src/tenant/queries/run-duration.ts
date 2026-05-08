import { type RawBuilder, sql } from "kysely";
import { getTenantDb } from "../internal";
import type { TenantScope } from "../index";

/**
 * Discrete-percentile run-duration queries used by the Run Duration
 * analytics page.
 *
 * `MAX(1, CAST(ROUND(cnt * q) AS INTEGER))` keeps the target rank in
 * [1..cnt] — without the floor of 1 a bucket with a single run would
 * resolve p50 to rank 0. Discrete percentiles (no R-7 interpolation):
 * fine at bar-chart resolution, far simpler in SQLite.
 */

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

export async function loadRunDurationPercentiles(
  scope: TenantScope,
  bucketExprSql: RawBuilder<unknown>,
  windowStartSec: number,
): Promise<{
  perBucket: PerBucketDurationRow[];
  overall: OverallDurationStats;
}> {
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;

  // Discrete-percentile pickers reused across the per-bucket and overall
  // queries — `MIN(CASE WHEN rn = MAX(1, ROUND(cnt * q)) THEN duration END)`
  // selects the duration at the ranked position for each percentile.
  const pickPercentile = (q: number) =>
    sql<
      number | null
    >`MIN(CASE WHEN "rn" = MAX(1, CAST(ROUND("cnt" * ${sql.raw(q.toFixed(2))}) AS INTEGER)) THEN "duration" END)`;

  const [perBucket, overall] = await Promise.all([
    db
      .with("ranked", (eb) =>
        eb
          .selectFrom("runs")
          .where("runs.projectId", "=", projectId)
          .where("runs.durationMs", ">", 0)
          .where("runs.createdAt", ">=", windowStartSec)
          .select([
            sql<number | string>`${bucketExprSql}`.as("bucket"),
            "runs.durationMs as duration",
            // Kysely's `partitionBy` types accept only column references,
            // not raw expressions, so the bucket-partitioned window
            // functions stay as `sql` here.
            sql<number>`row_number() OVER (PARTITION BY ${bucketExprSql} ORDER BY runs."durationMs")`.as(
              "rn",
            ),
            sql<number>`count(*) OVER (PARTITION BY ${bucketExprSql})`.as(
              "cnt",
            ),
          ]),
      )
      .selectFrom("ranked")
      .select((eb) => [
        "bucket",
        eb.fn.max<number>("cnt").as("cnt"),
        pickPercentile(0.5).as("p50"),
        pickPercentile(0.9).as("p90"),
        pickPercentile(0.95).as("p95"),
      ])
      .groupBy("bucket")
      .execute(),
    db
      .with("ranked", (eb) =>
        eb
          .selectFrom("runs")
          .where("runs.projectId", "=", projectId)
          .where("runs.durationMs", ">", 0)
          .where("runs.createdAt", ">=", windowStartSec)
          .select((eb2) => [
            "runs.durationMs as duration",
            eb2.fn
              .agg<number>("row_number")
              .over((o) => o.orderBy("runs.durationMs"))
              .as("rn"),
            eb2.fn.countAll<number>().over().as("cnt"),
          ]),
      )
      .selectFrom("ranked")
      .select((eb) => [
        eb.fn.max<number>("cnt").as("cnt"),
        pickPercentile(0.5).as("p50"),
        pickPercentile(0.9).as("p90"),
        pickPercentile(0.95).as("p95"),
      ])
      .executeTakeFirst(),
  ]);

  return {
    perBucket,
    overall: overall ?? { cnt: 0, p50: null, p90: null, p95: null },
  };
}
