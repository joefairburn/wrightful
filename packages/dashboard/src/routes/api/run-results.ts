import type { TenantScope } from "@/tenant";
import { tenantScopeForUser } from "@/tenant";
import type { AppContext } from "@/worker";
import type { RunProgressTest } from "./progress";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const VALID_STATUSES = new Set([
  "queued",
  "passed",
  "failed",
  "flaky",
  "skipped",
  "timedout",
]);

export interface RunResultsResponse {
  results: RunProgressTest[];
  nextCursor: string | null;
}

export interface LoadRunResultsOpts {
  /** Opaque base64 cursor from a prior page's `nextCursor`, or null. */
  cursor: string | null;
  /** Page size — clamped to MAX_LIMIT inside this function. */
  limit: number;
  /** Status filter; null returns all. */
  status: string | null;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

/**
 * Cursor-paginated fetch of testResults rows for a run. Returns null when
 * the run isn't owned by the caller's project — the route handler maps
 * that to a 404, the SSR seed path uses it as an existence check.
 *
 * Order matches the synced-state tail: createdAt DESC, id DESC. Cursor is
 * an opaque base64 of `${createdAt}:${id}` from the last row of the prior
 * page; an invalid cursor is silently treated as no cursor (returns the
 * first page) — matches the legacy route behaviour.
 */
export async function loadRunResultsPage(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
): Promise<RunResultsResponse | null> {
  const owner = await scope.db
    .selectFrom("runs")
    .select("id")
    .where("id", "=", runId)
    .where("projectId", "=", scope.projectId)
    .limit(1)
    .executeTakeFirst();
  if (!owner) return null;

  const limit = Math.min(Math.max(1, opts.limit), MAX_LIMIT);

  let q = scope.db
    .selectFrom("testResults")
    .select([
      "id",
      "testId",
      "title",
      "file",
      "projectName",
      "status",
      "durationMs",
      "retryCount",
      "errorMessage",
      "errorStack",
      "createdAt",
    ])
    .where("runId", "=", runId);

  if (opts.status) q = q.where("status", "=", opts.status);

  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    // Strict tuple comparison: (createdAt, id) < (cursor.createdAt, cursor.id)
    // in DESC order. Inlined as a chain since Kysely's Sqlite dialect
    // doesn't expose a row-value comparator.
    q = q.where((eb) =>
      eb.or([
        eb("createdAt", "<", cursor.createdAt),
        eb.and([
          eb("createdAt", "=", cursor.createdAt),
          eb("id", "<", cursor.id),
        ]),
      ]),
    );
  }

  const rows = await q
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1)
    .execute();

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
      status: r.status as RunProgressTest["status"],
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
 * SSR/initial-load source for the run-detail tests list and as the
 * client-side back-paginator for runs that exceed the visible window.
 */
export async function runResultsHandler({
  request,
  params,
  ctx,
}: {
  request: Request;
  params: Record<string, string>;
  ctx: AppContext;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const { teamSlug, projectSlug, runId } = params;
  if (!teamSlug || !projectSlug || !runId) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");
  if (statusFilter !== null && !VALID_STATUSES.has(statusFilter)) {
    return jsonResponse({ error: "Invalid status filter" }, 400);
  }

  const limitParam = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return jsonResponse({ error: "Invalid limit" }, 400);
    }
    limit = parsed;
  }

  const scope = await tenantScopeForUser(ctx.user.id, teamSlug, projectSlug);
  if (!scope) return new Response("Not found", { status: 404 });

  const result = await loadRunResultsPage(scope, runId, {
    cursor: url.searchParams.get("cursor"),
    limit,
    status: statusFilter,
  });
  if (!result) return new Response("Not found", { status: 404 });

  return jsonResponse(result, 200);
}
