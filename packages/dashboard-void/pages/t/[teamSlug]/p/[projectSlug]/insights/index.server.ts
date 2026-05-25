import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq, gte, sql } from "void/db";
import { runs } from "@schema";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { resolveProjectBySlugs } from "@/lib/authz";
import { DAY_SEC, parseSegment, SEGMENTS } from "@/lib/analytics/bucketing";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import type { AuthorizedProjectId, AuthorizedTeamId } from "@/lib/scope";

export type Props = InferProps<typeof loader>;

const RANGES = ["7d", "14d", "30d", "90d"] as const;
const parseRange = makeRangeParser(RANGES, "30d");

/**
 * Insights / Run Status loader. Groups runs by the chosen segment (day /
 * week / month) and aggregates pass/fail/flaky/skipped counters per bucket
 * plus the totals row for the KPI cards.
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
  const segment = parseSegment(url.searchParams.get("segment"), "day");
  const branchParam = url.searchParams.get("branch");
  const branchFilter =
    !branchParam || branchParam === ALL_BRANCHES ? null : branchParam;
  const rangeSec = rangeToSeconds(range);
  const days = rangeSec ? rangeSec / DAY_SEC : 30;

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - days * DAY_SEC;

  const scope = {
    teamId: project.teamId as AuthorizedTeamId,
    projectId: project.id as AuthorizedProjectId,
    teamSlug: project.teamSlug,
    projectSlug: project.slug,
  };
  const branches = await loadProjectBranches(scope);

  const expr = bucketExpr(segment);

  const aggConditions = [
    eq(runs.teamId, project.teamId),
    eq(runs.projectId, project.id),
    gte(runs.createdAt, windowStartSec),
  ];
  if (branchFilter) aggConditions.push(eq(runs.branch, branchFilter));

  // Drizzle's groupBy accepts an SQL fragment; we reuse the same `expr`
  // both in the SELECT (aliased "bucket") and the GROUP BY.
  const aggRows = await db
    .select({
      bucket: expr,
      passed: sql<number>`sum(passed)`,
      failed: sql<number>`sum(failed)`,
      flaky: sql<number>`sum(flaky)`,
      skipped: sql<number>`sum(skipped)`,
      runs: sql<number>`count(*)`,
    })
    .from(runs)
    .where(and(...aggConditions))
    .groupBy(expr);

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
    pathname: url.pathname,
    aggRows,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES as readonly string[],
  };
});
