import { defer, defineHandler, type InferProps } from "void";
import { and, db, desc, eq } from "void/db";
import { runs } from "@schema";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { loadProjectBranches } from "@/lib/branches-query";
import { loadRunResultsPage } from "@/lib/run-results-page";
import { RUN_PUBLIC_COLUMNS } from "@/lib/run-columns";
import { runByIdWhere, runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;
const TESTS_LIMIT = 200;

/**
 * Run detail loader. Resolves the active run + its history strip + the
 * first page of tests in a single batch. The page component subscribes via
 * `useRunRoom(runId)` for live updates merged on top of these SSR-seeded rows.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  if (!runId) throw new Response("Not Found", { status: 404 });

  const { project, scope } = requireTenantContext(c);

  const runRows = await db
    // Explicit projection — omits idempotencyKey (the write-reopen credential)
    // from the serialized props. See RUN_PUBLIC_COLUMNS.
    .select(RUN_PUBLIC_COLUMNS)
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const branchParam = url.searchParams.get("branch");
  const defaultBranch = run.branch ?? ALL_BRANCHES;
  const effectiveBranch = branchParam ?? defaultBranch;
  const tabParam = url.searchParams.get("tab");
  const tab: "tests" | "env" = tabParam === "env" ? "env" : "tests";

  // History query builder: last HISTORY_LIMIT runs, optionally filtered by
  // branch. Deferred (below), so `defer()`'s awaited promise is the query, not
  // an already-awaited result.
  const historyConditions = [runScopeWhere(scope)];
  if (effectiveBranch !== ALL_BRANCHES) {
    historyConditions.push(eq(runs.branch, effectiveBranch));
  }
  const historyQuery = db
    .select({
      id: runs.id,
      status: runs.status,
      durationMs: runs.durationMs,
      createdAt: runs.createdAt,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
    })
    .from(runs)
    .where(and(...historyConditions))
    .orderBy(desc(runs.createdAt))
    .limit(HISTORY_LIMIT);

  // Tests stay EAGER — they seed the realtime tests-list island. `<RunProgress>`
  // feeds `tests` straight into `useRunRoom({ initialTests })`, and that seed is
  // an identity dep of `useSeededState`: if `tests` streamed in as a deferred
  // prop, the array would arrive with a fresh reference AFTER the island had
  // already mounted its WS subscription and folded any `progress` events that
  // landed in the gap — the reseed would then DISCARD those folded events (rooms
  // have no replay, so they're gone for good), and the suspended island would
  // also connect its socket late. Both break live progress on an in-flight run.
  // So the ~200-row scan is awaited here alongside the 404-gated `run`.
  const resultsPage = await loadRunResultsPage(scope, runId, {
    cursor: null,
    limit: TESTS_LIMIT,
    status: null,
  });

  // The full-run select() above already 404s on a foreign/missing run, so the
  // run is owned here; loadRunResultsPage's own ownership probe agrees.
  const tests = resultsPage?.results ?? [];
  // Non-null when the run has more tests than TESTS_LIMIT — the client
  // back-paginates the rest from GET /results (see `useRunRoom`'s backfill)
  // so the Tests tab list + filter counts cover the whole run.
  const testsCursor = resultsPage?.nextCursor ?? null;

  // This loader sets no Cache-Control, so nothing changes there: a deferred
  // loader streams its body (NDJSON on SPA nav / chunked HTML on document load),
  // and the absence of a stored SWR/max-age response means the browser can't
  // replay the wrong variant. (See suite-size.server.ts for the case where a
  // pre-existing max-age header had to become `private, no-store`.)
  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      role: project.role,
    },
    run,
    runId,
    branchParam,
    defaultBranch,
    effectiveBranch,
    tab,
    pathname: url.pathname,
    tests,
    testsCursor,

    // Below-the-fold duration-trend chart + its inline branch filter. Grouped:
    // the chart reads `history` and its subtitle control reads `branches`, so
    // one resolver runs both queries in parallel and one skeleton covers the
    // whole card. Read-only and NOT a realtime seed (the branch filter's value
    // comes from the URL via `useNavigatingSearchParam`, not a room hook), so
    // deferring it can't tear the live islands.
    chart: defer(async () => {
      const [history, branches] = await Promise.all([
        historyQuery,
        loadProjectBranches(scope),
      ]);
      return { history, branches };
    }),
  };
});
