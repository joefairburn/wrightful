import { and, db, desc, eq, lt, or } from "void/db";
import { runs, testResults } from "@schema";
import { childByRunWhere, runByIdWhere, type TenantScope } from "@/lib/scope";
import type { RunProgressTest } from "@/realtime/run-progress";

export const DEFAULT_RUN_RESULTS_LIMIT = 200;
export const MAX_RUN_RESULTS_LIMIT = 500;

export interface RunResultsResponse {
  results: RunProgressTest[];
  nextCursor: string | null;
}

export interface LoadRunResultsOpts {
  cursor: string | null;
  limit: number;
  status: string | null;
}

/**
 * Decode an opaque base64 cursor of `${createdAt}:${id}` back into its
 * components. Returns `null` for any malformed input so callers degrade to
 * first-page (matches the legacy route's lenient behaviour).
 */
export function decodeCursor(
  raw: string | null,
): { createdAt: number; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0) return null;
  const createdAt = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isFinite(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

export function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`);
}

/**
 * Clamp a requested page size into the `[1, MAX_RUN_RESULTS_LIMIT]` range.
 */
export function clampRunResultsLimit(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_RUN_RESULTS_LIMIT);
}

/** The closed set the live client renders, as one typed list (no casts). */
const TEST_STATUSES: readonly RunProgressTest["status"][] = [
  "passed",
  "failed",
  "flaky",
  "skipped",
  "timedout",
  "queued",
];

/**
 * Coerce a raw `testResults.status` string into the closed set the live
 * client renders. Unknown values fall back to `queued` so the SSR seed and
 * the paginated pages agree on shape.
 */
export function normalizeTestStatus(s: string): RunProgressTest["status"] {
  return TEST_STATUSES.find((status) => status === s) ?? "queued";
}

/** A non-undefined Drizzle WHERE fragment, suitable for `.where(...)`. */
type SqlFragment = NonNullable<ReturnType<typeof and>>;

/** The canonical `(createdAt, id)` DESC ordering every run-tests page shares. */
export function runTestsOrderBy() {
  return [desc(testResults.createdAt), desc(testResults.id)] as const;
}

/**
 * The one cursor-paginated read over a run's `testResults`: owner probe,
 * status/cursor WHERE composition, the strict `(createdAt, id)` DESC tuple,
 * and the `hasMore → nextCursor` unwrap — all live HERE, once. Callers supply
 * only the column projection (`fetchRows`, which owns its own typed
 * `db.select` + `.orderBy(...runTestsOrderBy())`) and a row mapper, so a
 * projection that carries extra columns (the MCP surface's `errorMessage`)
 * reuses the exact pagination contract instead of forking it. `Row` must
 * expose `id` + `createdAt` so the shared cursor can be minted from any
 * projection. Returns `null` when the run isn't in scope; invalid cursors
 * silently degrade to first-page.
 */
export async function paginateRunTests<
  Row extends { id: string; createdAt: number },
  Out,
>(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
  fetchRows: (where: SqlFragment, limit: number) => Promise<Row[]>,
  mapRow: (row: Row) => Out,
): Promise<{ items: Out[]; nextCursor: string | null } | null> {
  // Confirm the run belongs to this project.
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return null;

  const limit = clampRunResultsLimit(opts.limit);

  const conditions = [childByRunWhere(testResults, scope, runId)];
  if (opts.status) {
    conditions.push(eq(testResults.status, opts.status));
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    // Strict tuple comparison (createdAt, id) < (cursor.createdAt, cursor.id)
    // for DESC pagination. Materialized as an OR so the planner can use the
    // (createdAt, id) ordering directly.
    const tupleClause = or(
      lt(testResults.createdAt, cursor.createdAt),
      and(
        eq(testResults.createdAt, cursor.createdAt),
        lt(testResults.id, cursor.id),
      ),
    );
    if (tupleClause) conditions.push(tupleClause);
  }

  const rows = await fetchRows(and(...conditions)!, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(mapRow),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/**
 * The one canonical definition of "a page of a run's testResults as
 * `RunProgressTest[]`": the GET /results API (back-paginator), the run-detail
 * page loader (SSR seed for `useRunRoom`), the v1 tests API, and export all go
 * through it. The MCP `list_tests` tool shares the same `paginateRunTests`
 * engine with a wider projection (see `loadMcpRunTests`), so scoping, ordering,
 * and the cursor contract can never drift between surfaces.
 */
export async function loadRunResultsPage(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
): Promise<RunResultsResponse | null> {
  const page = await paginateRunTests(
    scope,
    runId,
    opts,
    (where, limit) =>
      db
        .select({
          id: testResults.id,
          testId: testResults.testId,
          title: testResults.title,
          file: testResults.file,
          projectName: testResults.projectName,
          status: testResults.status,
          durationMs: testResults.durationMs,
          retryCount: testResults.retryCount,
          shardIndex: testResults.shardIndex,
          createdAt: testResults.createdAt,
        })
        .from(testResults)
        .where(where)
        .orderBy(...runTestsOrderBy())
        .limit(limit),
    (r) => ({
      id: r.id,
      testId: r.testId,
      title: r.title,
      file: r.file,
      projectName: r.projectName,
      status: normalizeTestStatus(r.status),
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      shardIndex: r.shardIndex,
    }),
  );
  if (!page) return null;
  return { results: page.items, nextCursor: page.nextCursor };
}
