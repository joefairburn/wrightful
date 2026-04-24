import { sql } from "kysely";
import { Database, ListPlus } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/app/components/analytics/bucket-bar-chart";
import { AnalyticsButtonGroup } from "@/app/components/analytics/button-group";
import { InsightsTabs } from "@/app/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/app/components/analytics/kpi-card";
import { Card, CardPanel } from "@/app/components/ui/card";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import {
  bucketExpr,
  bucketKey,
  buildEmptyBuckets,
  DAY_SEC,
  parseSegment,
  type Segment,
  SEGMENTS,
} from "@/lib/analytics/bucketing";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";
import { cn } from "@/lib/cn";

type RangeKey = "7d" | "30d" | "90d" | "1y" | "all";
const RANGES: readonly RangeKey[] = ["7d", "30d", "90d", "1y", "all"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "90d");

const DISTRIBUTION_LIMIT = 10;
const TAG_LIMIT = 12;
const ADDED_LOOKBACK_DAYS = 30;

/** Pick a sensible default segment based on the chosen range. Anything
 *  shorter than two weeks → day, up to 90d → week, longer → month. */
function defaultSegmentForRange(range: RangeKey): Segment {
  if (range === "7d") return "day";
  if (range === "30d") return "day";
  if (range === "90d") return "week";
  return "month";
}

export async function SuiteSizePage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const range = parseRange(url.searchParams.get("range"));
  const segment = parseSegment(
    url.searchParams.get("segment"),
    defaultSegmentForRange(range),
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const rangeSec = rangeToSeconds(range);
  // "all" ⇒ no lower bound; anchor shells at the project's first run.
  const windowStartSec = rangeSec ? nowSec - rangeSec : 0;

  const expr = bucketExpr(segment);

  // 1. Peak suite size per bucket. `max(totalTests)` is a tight proxy
  //    for the size of the suite at the time of the largest run in that
  //    bucket — cheap to compute and matches the single-series bar
  //    chart in the prototype.
  const trendRows = await project.db
    .selectFrom("runs")
    .where("projectId", "=", project.id)
    .where("committed", "=", 1)
    .where("createdAt", ">=", windowStartSec)
    .select([expr.as("bucket"), sql<number>`max("totalTests")`.as("peak")])
    .groupBy(expr)
    .execute();

  // For "all", find the earliest run so the shell skeleton doesn't
  // stretch back to 1970. Otherwise use the requested window.
  let shellStartSec = windowStartSec;
  if (rangeSec === null) {
    const earliest = await project.db
      .selectFrom("runs")
      .where("projectId", "=", project.id)
      .where("committed", "=", 1)
      .select(sql<number | null>`min("createdAt")`.as("first"))
      .executeTakeFirst();
    shellStartSec = earliest?.first ?? nowSec;
  }

  const peakOverall = Math.max(0, ...trendRows.map((r) => r.peak));

  // 2. Tests Added (last 30d) — distinct testIds whose first-ever
  //    occurrence falls inside the lookback. Subquery is cheap: it
  //    groups over testResults which is already narrow-keyed on testId.
  const addedLookbackSec = nowSec - ADDED_LOOKBACK_DAYS * DAY_SEC;
  const addedRow = await project.db
    .selectFrom(
      project.db
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .where("runs.projectId", "=", project.id)
        .where("runs.committed", "=", 1)
        .select([
          "testResults.testId as testId",
          sql<number>`min("testResults"."createdAt")`.as("firstSeen"),
        ])
        .groupBy("testResults.testId")
        .as("firsts"),
    )
    .select(sql<number>`count(*)`.as("added"))
    .where("firstSeen", ">=", addedLookbackSec)
    .executeTakeFirst();
  const testsAdded = addedRow?.added ?? 0;

  // 3. Distribution by spec file — distinct testIds per file in window.
  const fileRows = await project.db
    .selectFrom("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("runs.projectId", "=", project.id)
    .where("runs.committed", "=", 1)
    .where("testResults.createdAt", ">=", windowStartSec)
    .select([
      "testResults.file as file",
      sql<number>`count(distinct "testResults"."testId")`.as("tests"),
    ])
    .groupBy("testResults.file")
    .orderBy("tests", "desc")
    .limit(DISTRIBUTION_LIMIT)
    .execute();
  const fileTotal = fileRows.reduce((acc, r) => acc + r.tests, 0);

  // 4. Top tags — distinct-testId count per tag in window.
  const tagRows = await project.db
    .selectFrom("testTags")
    .innerJoin("testResults", "testResults.id", "testTags.testResultId")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("runs.projectId", "=", project.id)
    .where("runs.committed", "=", 1)
    .where("testResults.createdAt", ">=", windowStartSec)
    .select([
      "testTags.tag as tag",
      sql<number>`count(distinct "testResults"."testId")`.as("tests"),
    ])
    .groupBy("testTags.tag")
    .orderBy("tests", "desc")
    .limit(TAG_LIMIT)
    .execute();

  // 5. Trend chart buckets — single-series bar.
  const shells = buildEmptyBuckets(segment, shellStartSec, nowSec);
  const peaksByKey = new Map(
    trendRows.map((r) => [bucketKey(r.bucket), r.peak]),
  );
  const primaryColor = "var(--color-primary)";
  const buckets: BucketBarChartBucket[] = shells.map((s) => {
    const peak = peaksByKey.get(s.key) ?? 0;
    return {
      key: s.key,
      label: s.label,
      total: peak,
      segments: [{ count: peak, color: primaryColor }],
      tooltip: (
        <>
          <div className="mb-1 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label}
          </div>
          <div className="font-mono text-xs">
            <span className="text-foreground">{peak.toLocaleString()}</span>{" "}
            <span className="text-muted-foreground">tests</span>
          </div>
        </>
      ),
    };
  });

  const hrefWith = (overrides: Record<string, string>): string => {
    const p = new URLSearchParams(url.searchParams);
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    return `${url.pathname}?${p.toString()}`;
  };

  return (
    <>
      <InsightsTabs
        teamSlug={project.teamSlug}
        projectSlug={project.slug}
        active="suite-size"
      />

      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Suite Size Growth
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wider">
            Test volume and distribution · {rangeLabel(range)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsButtonGroup
            options={SEGMENTS}
            value={segment}
            hrefFor={(s) => hrefWith({ segment: s })}
          />
          <AnalyticsButtonGroup
            options={RANGES}
            value={range}
            hrefFor={(r) => hrefWith({ range: r })}
            labelFor={(r) => r.toUpperCase()}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 flex flex-col gap-4">
            <AnalyticsKpiCard
              label="Total Tests"
              value={peakOverall.toLocaleString()}
              Icon={Database}
              footnote="Peak suite size observed in the window"
            />
            <AnalyticsKpiCard
              label={`Tests Added (${ADDED_LOOKBACK_DAYS}d)`}
              value={testsAdded.toLocaleString()}
              Icon={ListPlus}
              footnote="Tests whose first-ever run is in the last 30 days"
            />
          </div>
          <div className="lg:col-span-8">
            <Card>
              <div className="flex items-center justify-between px-6 pt-5 pb-3">
                <div>
                  <h2 className="text-base font-semibold">Growth Trend</h2>
                  <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                    Peak suite size per {segment}
                  </p>
                </div>
              </div>
              <CardPanel className="pt-0">
                <BucketBarChart
                  buckets={buckets}
                  height={360}
                  ariaLabel={`Suite size trend across ${buckets.length} buckets`}
                  emptyState="No runs in this window."
                />
              </CardPanel>
            </Card>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Card>
              <div className="px-6 pt-5 pb-3">
                <h2 className="text-base font-semibold">
                  Distribution by spec file
                </h2>
                <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                  Top {fileRows.length} files by distinct test count
                </p>
              </div>
              <CardPanel className="pt-0">
                {fileRows.length === 0 ? (
                  <EmptyRow>No tests in this window.</EmptyRow>
                ) : (
                  <ul className="space-y-3">
                    {fileRows.map((r) => (
                      <DistributionRow
                        key={r.file}
                        label={r.file}
                        value={r.tests}
                        total={fileTotal}
                      />
                    ))}
                  </ul>
                )}
              </CardPanel>
            </Card>
          </div>

          <div className="lg:col-span-1">
            <Card>
              <div className="px-6 pt-5 pb-3">
                <h2 className="text-base font-semibold">Top tags</h2>
                <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                  Distinct tests per tag
                </p>
              </div>
              <CardPanel className="pt-0">
                {tagRows.length === 0 ? (
                  <EmptyRow>No tagged tests.</EmptyRow>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {tagRows.map((r) => (
                      <span
                        key={r.tag}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 font-mono text-xs text-foreground"
                      >
                        <span>{r.tag}</span>
                        <span className="text-muted-foreground">
                          {r.tests.toLocaleString()}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </CardPanel>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

function rangeLabel(r: RangeKey): string {
  if (r === "all") return "All time";
  if (r === "1y") return "Last year";
  return `Last ${parseInt(r, 10)} days`;
}

function DistributionRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : (value / total) * 100;
  return (
    <li className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {label}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full bg-foreground/80")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="w-16 text-right font-mono text-sm text-foreground">
        {value.toLocaleString()}
      </div>
      <div className="w-12 text-right font-mono text-[11px] text-muted-foreground">
        {pct.toFixed(0)}%
      </div>
    </li>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
