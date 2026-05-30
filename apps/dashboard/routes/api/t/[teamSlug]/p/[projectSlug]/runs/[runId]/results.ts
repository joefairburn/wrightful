import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, lt, or } from "void/db";
import { z } from "zod";
import { runs, testResults } from "@schema";
import {
  runByIdWhere,
  tenantScopeForUserBySlugs,
  type TenantScope,
} from "@/lib/scope";
import type { RunProgressTest } from "@/lib/live-client";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const STATUS_VALUES = [
  "queued",
  "passed",
  "failed",
  "flaky",
  "skipped",
  "timedout",
] as const;

const QuerySchema = z.object({
  status: z.enum(STATUS_VALUES).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
});

export interface RunResultsResponse {
  results: RunProgressTest[];
  nextCursor: string | null;
}

export interface LoadRunResultsOpts {
  cursor: string | null;
  limit: number;
  status: string | null;
}

function decodeCursor(
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

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`);
}

function normalizeTestStatus(s: string): RunProgressTest["status"] {
  if (
    s === "passed" ||
    s === "failed" ||
    s === "flaky" ||
    s === "skipped" ||
    s === "timedout" ||
    s === "queued"
  ) {
    return s;
  }
  return "queued";
}

/**
 * Cursor-paginated fetch of testResults rows for a run. Order is
 * `(createdAt DESC, id DESC)` — cursor is opaque base64 of
 * `${createdAt}:${id}` from the previous page's last row. Invalid cursors
 * silently degrade to first-page (matches the legacy route).
 */
export async function loadRunResultsPage(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
): Promise<RunResultsResponse | null> {
  // Confirm the run belongs to this project.
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return null;

  const limit = Math.min(Math.max(1, opts.limit), MAX_LIMIT);

  const conditions = [
    eq(testResults.projectId, scope.projectId),
    eq(testResults.runId, runId),
  ];
  if (opts.status) {
    conditions.push(eq(testResults.status, opts.status));
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    // Strict tuple comparison (createdAt, id) < (cursor.createdAt, cursor.id)
    // for DESC pagination. Materialized as an OR so SQLite's planner can use
    // the (createdAt, id) ordering directly.
    const tupleClause = or(
      lt(testResults.createdAt, cursor.createdAt),
      and(
        eq(testResults.createdAt, cursor.createdAt),
        lt(testResults.id, cursor.id),
      ),
    );
    if (tupleClause) conditions.push(tupleClause);
  }

  const rows = await db
    .select({
      id: testResults.id,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      projectName: testResults.projectName,
      status: testResults.status,
      durationMs: testResults.durationMs,
      retryCount: testResults.retryCount,
      errorMessage: testResults.errorMessage,
      errorStack: testResults.errorStack,
      createdAt: testResults.createdAt,
    })
    .from(testResults)
    .where(and(...conditions))
    .orderBy(desc(testResults.createdAt), desc(testResults.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return {
    results: page.map((r) => ({
      id: r.id,
      testId: r.testId,
      title: r.title,
      file: r.file,
      projectName: r.projectName,
      status: normalizeTestStatus(r.status),
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      errorMessage: r.errorMessage,
      errorStack: r.errorStack,
    })),
    nextCursor,
  };
}

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/results
 *
 * Cursor-paginated full set of testResults for a run. Used both as the
 * initial-load source for the run-detail tests list and as the client-side
 * back-paginator for runs that exceed the visible window.
 */
export const GET = defineHandler.withValidator({
  query: QuerySchema,
})(async (c, { query }) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  const runId = c.req.param("runId");
  if (!teamSlug || !projectSlug || !runId) {
    return c.json({ error: "Not found" }, 404);
  }

  const scope = await tenantScopeForUserBySlugs(user.id, teamSlug, projectSlug);
  if (!scope) return c.json({ error: "Not found" }, 404);

  const result = await loadRunResultsPage(scope, runId, {
    cursor: query.cursor ?? null,
    limit: query.limit ?? DEFAULT_LIMIT,
    status: query.status ?? null,
  });
  if (!result) return c.json({ error: "Not found" }, 404);
  return result;
});
