import { all } from "better-all";
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

  const url = new URL(c.req.url);

  // Batch the 404-gate run lookup with the tests seed + branch list in one
  // parallel step (no serialized gate). All three are independently
  // scope-filtered — `loadRunResultsPage`/`loadProjectBranches` return empty for
  // a foreign/missing run — so none needs `run` resolved first; we throw 404
  // after the batch. Saves a DB round-trip on the common (valid-run) path.
  //
  // Tests stay EAGER — they seed the realtime tests-list island. `<RunProgress>`
  // feeds `tests` straight into `useRunRoom({ initialTests })`, and that seed is
  // an identity dep of `useSeededState`: if `tests` streamed in as a deferred
  // prop, the array would arrive with a fresh reference AFTER the island had
  // already mounted its WS subscription and folded any `progress` events that
  // landed in the gap — the reseed would then DISCARD those folded events (rooms
  // have no replay, so they're gone for good), and the suspended island would
  // also connect its socket late. Both break live progress on an in-flight run.
  // `branches` is a cheap index-covered DISTINCT and drives the always-visible
  // branch filter in the chart's title row. Loading it EAGER lets the chart's
  // skeleton render the real filter + title row while only the history plot
  // streams in — so the title row is identical markup in both states and can't
  // shift. Only `history` stays deferred.
  const { runRows, resultsPage, branches } = await all({
    async runRows() {
      // Explicit projection — omits idempotencyKey (the write-reopen credential)
      // from the serialized props. See RUN_PUBLIC_COLUMNS.
      return db
        .select(RUN_PUBLIC_COLUMNS)
        .from(runs)
        .where(runByIdWhere(scope, runId))
        .limit(1);
    },
    async resultsPage() {
      return loadRunResultsPage(scope, runId, {
        cursor: null,
        limit: TESTS_LIMIT,
        status: null,
      });
    },
    async branches() {
      return loadProjectBranches(scope);
    },
  });
  const run = runRows[0];
  if (!run) throw new Response("Not Found", { status: 404 });

  const branchParam = url.searchParams.get("branch");
  const defaultBranch = run.branch ?? ALL_BRANCHES;
  const effectiveBranch = branchParam ?? defaultBranch;
  const tabParam = url.searchParams.get("tab");
  const tab: "tests" | "env" = tabParam === "env" ? "env" : "tests";

  // History query builder: last HISTORY_LIMIT runs, optionally filtered by
  // branch. Deferred (below), so `defer()`'s awaited promise is the query, not
  // an already-awaited result. Built after `run` is known (needs its branch).
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
    branches,

    // Below-the-fold duration-trend history. ONLY the plot data is deferred —
    // the card chrome, title, and branch filter render eagerly from `branches`
    // above (see RunHistoryChartFrame), so the skeleton→chart swap changes only
    // the plot body and can't shift the title row. Read-only and NOT a realtime
    // seed (the branch filter reads the URL via `useNavigatingSearchParam`, not
    // a room hook), so deferring it can't tear the live islands.
    chart: defer(async () => {
      const history = await historyQuery;
      return { history };
    }),
  };
});
