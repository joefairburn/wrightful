import { defineHandler, type InferProps } from "void";
import { db, sql } from "void/db";
import { z } from "zod";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { loadProjectBranches } from "@/lib/branches-query";
import { rangeToSeconds } from "@/lib/analytics/range";
import { requireTenantContext } from "@/lib/tenant-context";

// withValidator's TypedHandler doesn't auto-await the handler return like
// the plain `defineHandler` overload does (see void/dist/handler.d.mts).
// Wrap in `Awaited<>` so consumers see the resolved shape.
export type Props = Awaited<InferProps<typeof loader>>;

const RANGES = ["7d", "14d", "30d"] as const;
type RangeKey = (typeof RANGES)[number];

const PAGE_SIZE = 50;

export interface TestsPageRow {
  testId: string;
  title: string;
  file: string;
  latestStatus: string;
  latestRunId: string | null;
  latestTestResultId: string | null;
  lastSeen: number;
  n: number;
  avgDurationMs: number | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

interface PageQueryRow {
  testId: string;
  lastSeen: number;
  totalDistinct: number;
}

interface AggregateRow {
  testId: string;
  n: number;
  avgDurationMs: number | null;
  title: string | null;
  file: string | null;
  latestStatus: string | null;
  latestRunId: string | null;
  latestTestResultId: string | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

/**
 * Test catalog loader. Two-pass query:
 *  1. Paginate testIds by `max(testResults.createdAt) DESC` with a windowed
 *     `count(*) OVER ()` to fold pagination math into the same statement.
 *  2. Aggregate per-test counters + latest title/file/status for the page slice.
 *
 * Search params are validated via `withValidator({ query })` per Void's
 * typed-routes contract — the schema flows into the auto-generated
 * `.void/routes.d.ts` so client-side `void/client#fetch` callers see the
 * same shape.
 */
export const loader = defineHandler.withValidator({
  query: z.object({
    range: z.enum(RANGES).optional(),
    branch: z.string().optional(),
    q: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
  }),
})(async (c, { query }) => {
  const { project, scope } = requireTenantContext(c);

  const range: RangeKey = query.range ?? "14d";
  const branchParam = query.branch ?? null;
  const branchFilter =
    !branchParam || branchParam === ALL_BRANCHES ? null : branchParam;
  const q = (query.q ?? "").trim();
  const requestedPage = query.page ?? 1;

  const branches = await loadProjectBranches(scope);
  const nowSec = Math.floor(Date.now() / 1000);
  const rangeSec = rangeToSeconds(range) ?? 0;
  const windowStartSec = nowSec - rangeSec;

  const pattern = q ? `%${q}%` : null;
  const branchSql = branchFilter
    ? sql`and runs.branch = ${branchFilter}`
    : sql``;
  const qSql = pattern
    ? sql`and (tr.title like ${pattern} or tr.file like ${pattern})`
    : sql``;

  const offset = (requestedPage - 1) * PAGE_SIZE;
  let pageRows = await runPageQuery(
    scope.projectId,
    windowStartSec,
    branchSql,
    qSql,
    offset,
  );

  const totalUniqueTests = pageRows[0]?.totalDistinct ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalUniqueTests / PAGE_SIZE));

  let currentPage = requestedPage;
  if (pageRows.length === 0 && totalUniqueTests > 0 && requestedPage > 1) {
    currentPage = totalPages;
    pageRows = await runPageQuery(
      scope.projectId,
      windowStartSec,
      branchSql,
      qSql,
      (currentPage - 1) * PAGE_SIZE,
    );
  } else {
    currentPage = Math.min(requestedPage, totalPages);
  }

  let rows: TestsPageRow[] = [];
  if (pageRows.length > 0) {
    const lastSeenById = new Map(pageRows.map((r) => [r.testId, r.lastSeen]));
    const testIds = pageRows.map((r) => r.testId);
    const aggById = await runAggregateQuery(
      scope.projectId,
      windowStartSec,
      branchSql,
      testIds,
    );
    rows = testIds.flatMap((id) => {
      const a = aggById.get(id);
      const lastSeen = lastSeenById.get(id) ?? 0;
      if (!a) return [];
      return [
        {
          testId: id,
          title: a.title ?? "",
          file: a.file ?? "",
          latestStatus: a.latestStatus ?? "",
          latestRunId: a.latestRunId,
          latestTestResultId: a.latestTestResultId,
          lastSeen,
          n: a.n,
          avgDurationMs: a.avgDurationMs,
          passedCount: a.passedCount,
          flakyCount: a.flakyCount,
          failCount: a.failCount,
          skippedCount: a.skippedCount,
        },
      ];
    });
  }

  const fromRow =
    totalUniqueTests === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const toRow = (currentPage - 1) * PAGE_SIZE + rows.length;

  const url = new URL(c.req.url);
  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    range,
    branchParam,
    branchFilter,
    branches,
    q,
    rows,
    totalUniqueTests,
    currentPage,
    totalPages,
    fromRow,
    toRow,
    pathname: url.pathname,
    ranges: RANGES,
  };
});

async function runPageQuery(
  projectId: string,
  windowStartSec: number,
  branchSql: ReturnType<typeof sql>,
  qSql: ReturnType<typeof sql>,
  offset: number,
): Promise<PageQueryRow[]> {
  const result = await db.run(sql`
    with grouped as (
      select
        tr."testId" as "testId",
        max(tr."createdAt") as "lastSeen",
        count(*) over () as "totalDistinct"
      from "testResults" tr
      inner join runs on runs.id = tr."runId"
      where tr."projectId" = ${projectId}
        and runs."createdAt" >= ${windowStartSec}
        ${branchSql}
        ${qSql}
      group by tr."testId"
    )
    select "testId", "lastSeen", "totalDistinct"
    from grouped
    order by "lastSeen" desc
    limit ${PAGE_SIZE}
    offset ${offset}
  `);
  return (result.results as PageQueryRow[]) ?? [];
}

async function runAggregateQuery(
  projectId: string,
  windowStartSec: number,
  branchSql: ReturnType<typeof sql>,
  testIds: readonly string[],
): Promise<Map<string, AggregateRow>> {
  const result = await db.run(sql`
    with ranked as (
      select
        tr."testId" as "testId",
        tr.title as title,
        tr.file as file,
        tr.status as status,
        tr."durationMs" as "durationMs",
        tr."createdAt" as "createdAt",
        tr."runId" as "runId",
        tr.id as "testResultId",
        row_number() over (
          partition by tr."testId"
          order by tr."createdAt" desc
        ) as "rnTime"
      from "testResults" tr
      inner join runs on runs.id = tr."runId"
      where tr."projectId" = ${projectId}
        and runs."createdAt" >= ${windowStartSec}
        and tr."testId" in (${sql.join(
          testIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ${branchSql}
    )
    select
      "testId",
      count(*) as n,
      avg("durationMs") as "avgDurationMs",
      max(case when "rnTime" = 1 then title end) as title,
      max(case when "rnTime" = 1 then file end) as file,
      max(case when "rnTime" = 1 then status end) as "latestStatus",
      max(case when "rnTime" = 1 then "runId" end) as "latestRunId",
      max(case when "rnTime" = 1 then "testResultId" end) as "latestTestResultId",
      sum(case when status = 'passed' then 1 else 0 end) as "passedCount",
      sum(case when status = 'flaky' then 1 else 0 end) as "flakyCount",
      sum(case when status in ('failed','timedout') then 1 else 0 end) as "failCount",
      sum(case when status = 'skipped' then 1 else 0 end) as "skippedCount"
    from ranked
    group by "testId"
  `);
  const rows = (result.results as AggregateRow[]) ?? [];
  return new Map(rows.map((r) => [r.testId, r]));
}
