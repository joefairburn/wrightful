import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, gte, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import { resolveProjectBySlugs } from "@/lib/authz";
import {
  DAY_SEC,
  parseSegment,
  SEGMENTS,
  type Segment,
} from "@/lib/analytics/bucketing";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";

export type Props = InferProps<typeof loader>;

type RangeKey = "7d" | "30d" | "90d" | "1y" | "all";
const RANGES: readonly RangeKey[] = ["7d", "30d", "90d", "1y", "all"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "90d");

const DISTRIBUTION_LIMIT = 10;
const TAG_LIMIT = 12;
const ADDED_LOOKBACK_DAYS = 30;

function defaultSegmentForRange(range: RangeKey): Segment {
  if (range === "7d") return "day";
  if (range === "30d") return "day";
  if (range === "90d") return "week";
  return "month";
}

/**
 * Suite size loader. Four query passes:
 *   1. Peak suite size per bucket — max(totalTests) grouped by segment.
 *   2. Earliest run timestamp (for "all" range shells).
 *   3. Tests Added (last N days) — distinct testIds with first-ever run in window.
 *   4. Distribution by spec file + top tags.
 */
export const loader = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  if (!teamSlug || !projectSlug) {
    throw new Response("Not Found", { status: 404 });
  }
  const project = await resolveProjectBySlugs(user.id, teamSlug, projectSlug);
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const segment = parseSegment(
    url.searchParams.get("segment"),
    defaultSegmentForRange(range),
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const rangeSec = rangeToSeconds(range);
  const windowStartSec = rangeSec ? nowSec - rangeSec : 0;
  const expr = bucketExpr(segment);

  const trendRows = await db
    .select({
      bucket: expr,
      peak: sql<number>`max(${runs.totalTests})`,
    })
    .from(runs)
    .where(
      and(
        eq(runs.teamId, project.teamId),
        eq(runs.projectId, project.id),
        gte(runs.createdAt, windowStartSec),
      ),
    )
    .groupBy(expr);

  // For "all", find the earliest run so shells don't stretch back to 1970.
  let shellStartSec = windowStartSec;
  if (rangeSec === null) {
    const earliest = await db
      .select({ first: sql<number | null>`min(${runs.createdAt})` })
      .from(runs)
      .where(
        and(eq(runs.teamId, project.teamId), eq(runs.projectId, project.id)),
      );
    shellStartSec = earliest[0]?.first ?? nowSec;
  }

  const addedLookbackSec = nowSec - ADDED_LOOKBACK_DAYS * DAY_SEC;
  const testsAddedRow = await db.run(sql`
    select count(*) as added
    from (
      select tr."testId" as "testId", min(tr."createdAt") as "firstSeen"
      from "testResults" tr
      where tr."projectId" = ${project.id}
      group by tr."testId"
    ) firsts
    where firsts."firstSeen" >= ${addedLookbackSec}
  `);
  const testsAdded =
    (testsAddedRow.results?.[0] as { added?: number } | undefined)?.added ?? 0;

  const fileRows = await db
    .select({
      file: testResults.file,
      tests: sql<number>`count(distinct ${testResults.testId})`,
    })
    .from(testResults)
    .where(
      and(
        eq(testResults.projectId, project.id),
        gte(testResults.createdAt, windowStartSec),
      ),
    )
    .groupBy(testResults.file)
    .orderBy(desc(sql`count(distinct ${testResults.testId})`))
    .limit(DISTRIBUTION_LIMIT);

  const tagRows = await db
    .select({
      tag: testTags.tag,
      tests: sql<number>`count(distinct ${testResults.testId})`,
    })
    .from(testTags)
    .innerJoin(testResults, eq(testResults.id, testTags.testResultId))
    .where(
      and(
        eq(testResults.projectId, project.id),
        gte(testResults.createdAt, windowStartSec),
      ),
    )
    .groupBy(testTags.tag)
    .orderBy(desc(sql`count(distinct ${testResults.testId})`))
    .limit(TAG_LIMIT);

  const peakOverall = Math.max(0, ...trendRows.map((r) => r.peak ?? 0));

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
    rangeSec,
    nowSec,
    shellStartSec,
    trendRows: trendRows.map((r) => ({
      bucket: r.bucket,
      peak: r.peak ?? 0,
    })),
    testsAdded,
    addedLookbackDays: ADDED_LOOKBACK_DAYS,
    peakOverall,
    fileRows,
    tagRows,
    pathname: url.pathname,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES as readonly string[],
  };
});
