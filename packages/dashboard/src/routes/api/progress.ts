import { env } from "cloudflare:workers";
import type { TenantScope } from "@/tenant";

export type RunProgressTestStatus =
  | "queued"
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "timedout";

export type RunProgressStatus =
  | "running"
  | "passed"
  | "failed"
  | "flaky"
  | "timedout"
  | "interrupted";

export interface RunProgressTest {
  /** `testResults.id` — stable across streaming; used for tests/:id links. */
  id: string;
  testId: string;
  title: string;
  projectName: string | null;
  file: string;
  status: RunProgressTestStatus;
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  errorStack: string | null;
}

/**
 * Headline counters + run-level state for one run. Pushed to subscribers
 * of the `"summary"` synced-state key. ~150 B on the wire so re-broadcasts
 * are essentially free.
 */
export interface RunSummary {
  status: RunProgressStatus;
  totalDone: number;
  expectedTotal: number | null;
  counts: {
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    queued: number;
  };
  totalTests: number;
  updatedAt: number;
}

/**
 * Newest-first window of test result rows. Pushed to subscribers of the
 * `"tests-tail"` synced-state key. Clients merge tail rows into a
 * REST-loaded base list by `RunProgressTest.id` (tail wins) — the tail
 * is purely the live-edit window over a list the client already has.
 */
export interface RunTestsTail {
  tests: RunProgressTest[];
  updatedAt: number;
}

/**
 * Cap on the number of testResults rows included in a tail broadcast.
 * Sized so the wire payload stays comfortably under ~10 KB while
 * covering the typical mid-run "what just happened" window. Larger
 * runs are loaded in full via the cursor-paginated REST endpoint at
 * `/api/.../runs/:runId/results`; the tail is purely live updates on
 * top of that base list.
 */
export const TESTS_TAIL_SIZE = 50;

/**
 * Canonical roomId for the realtime DO backing a run's progress. The shape
 * is parsed + auth-gated by `registerRoomHandler` in `worker.tsx`.
 */
export function runRoomId(scope: {
  teamSlug: string;
  projectSlug: string;
  runId: string;
}): string {
  return `run:${scope.teamSlug}:${scope.projectSlug}:${scope.runId}`;
}

/** Narrow an arbitrary `runs.status` string to the RunProgressStatus union. */
function normalizeRunStatus(status: string): RunProgressStatus {
  switch (status) {
    case "running":
    case "passed":
    case "failed":
    case "flaky":
    case "timedout":
    case "interrupted":
      return status;
    default:
      return "running";
  }
}

function normalizeTestStatus(status: string): RunProgressTestStatus {
  switch (status) {
    case "queued":
    case "passed":
    case "failed":
    case "flaky":
    case "skipped":
    case "timedout":
      return status;
    default:
      return "queued";
  }
}

/** Subset of `runs` columns needed to derive a `RunSummary`. */
export interface RunRowForSummary {
  id: string;
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  expectedTotalTests: number | null;
}

interface TestResultRowForTail {
  id: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  errorStack: string | null;
}

/**
 * Pure derivation of `RunSummary` from a `runs` row. Exposed so callers
 * that already loaded the row (page SSR) can build a seed without an
 * extra DO hop. `queued` is derived from `totalTests - completed` so
 * it stays accurate independent of the tail.
 */
export function buildRunSummary(run: RunRowForSummary): RunSummary {
  const totalDone = run.passed + run.failed + run.flaky + run.skipped;
  const queued = Math.max(0, run.totalTests - totalDone);
  return {
    status: normalizeRunStatus(run.status),
    totalDone,
    expectedTotal: run.expectedTotalTests,
    counts: {
      passed: run.passed,
      failed: run.failed,
      flaky: run.flaky,
      skipped: run.skipped,
      queued,
    },
    totalTests: run.totalTests,
    updatedAt: Date.now(),
  };
}

function buildRunTestsTail(
  rows: readonly TestResultRowForTail[],
): RunTestsTail {
  return {
    tests: rows.map((r) => ({
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
    updatedAt: Date.now(),
  };
}

/**
 * Compose a `RunSummary` from the team's tenant DO. One run-row read; no
 * testResults scan. Used by `broadcastRunUpdate` and any caller that
 * doesn't already hold the row.
 */
export async function composeRunSummary(
  scope: TenantScope,
  runId: string,
): Promise<RunSummary | null> {
  const run = await scope.db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .limit(1)
    .executeTakeFirst();
  if (!run) return null;
  return buildRunSummary(run);
}

/**
 * Pure batch transform over already-loaded run rows (e.g. the runs-list
 * page's main query). No DB read — every aggregate is on the row.
 */
export function composeRunSummaryBatch(
  runs: readonly RunRowForSummary[],
): Map<string, RunSummary> {
  const out = new Map<string, RunSummary>();
  for (const run of runs) out.set(run.id, buildRunSummary(run));
  return out;
}

/**
 * Compose the live tests-tail (newest TESTS_TAIL_SIZE rows) for a run.
 * One testResults read; no run-row read.
 */
export async function composeRunTestsTail(
  scope: TenantScope,
  runId: string,
): Promise<RunTestsTail> {
  const rows = await scope.db
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
    ])
    .where("runId", "=", runId)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(TESTS_TAIL_SIZE)
    .execute();
  return buildRunTestsTail(rows);
}

/**
 * Compose summary + tail in parallel and broadcast each via `setState`
 * on its own synced-state key. Subscribers to `"summary"` see counter
 * updates only; subscribers to `"tests-tail"` see the latest test rows
 * only. Both keys share one realtime room so a single WebSocket serves
 * both islands.
 *
 * Best-effort: any error here is logged but never propagated — the
 * tenant DO is the source of truth; the realtime layer is a delivery
 * channel. Ingest writes must not fail because a DO stub is unreachable.
 */
export async function broadcastRunUpdate(
  scope: TenantScope,
  runId: string,
): Promise<void> {
  try {
    const [summary, tail] = await Promise.all([
      composeRunSummary(scope, runId),
      composeRunTestsTail(scope, runId),
    ]);
    if (!summary) return;
    const ns = env.SYNCED_STATE_SERVER;
    const stub = ns.get(
      ns.idFromName(
        runRoomId({
          teamSlug: scope.teamSlug,
          projectSlug: scope.projectSlug,
          runId,
        }),
      ),
    );
    await Promise.all([
      stub.setState(summary, "summary"),
      stub.setState(tail, "tests-tail"),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`broadcastRunUpdate(${runId}) failed: ${message}`);
  }
}
