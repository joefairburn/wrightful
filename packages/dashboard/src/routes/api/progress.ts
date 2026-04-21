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

export interface RunProgress {
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
  tests: RunProgressTest[];
  updatedAt: number;
}

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

/**
 * Compose the full progress snapshot for a run from the team's tenant DO.
 * Takes a `TenantScope` so the caller is forced to have been authorized
 * already — there's no raw-teamId entry point.
 *
 * Called from the ingest handlers to build the payload that's then
 * broadcast via `setState` on the realtime DO, and from SSR on the run
 * detail / list pages to seed the initial island state.
 */
export async function composeRunProgress(
  scope: TenantScope,
  runId: string,
): Promise<RunProgress | null> {
  const run = await scope.db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .limit(1)
    .executeTakeFirst();
  if (!run) return null;

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
    .execute();

  const tests: RunProgressTest[] = rows.map((r) => ({
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
  }));

  let queued = 0;
  for (const t of tests) if (t.status === "queued") queued += 1;
  const totalDone = run.passed + run.failed + run.flaky + run.skipped;

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
    tests,
    updatedAt: Date.now(),
  };
}

/**
 * Compose the latest progress from the tenant DO and broadcast it via
 * `setState` on the realtime DO. Clients subscribed via
 * `useSyncedState("progress", roomId)` receive the new value instantly.
 *
 * Best-effort: any error here is logged but never propagated — the tenant
 * DO is the source of truth; the realtime layer is a delivery channel.
 * Ingest writes must not fail because a DO stub is unreachable.
 */
export async function broadcastRunProgress(
  scope: TenantScope,
  runId: string,
): Promise<void> {
  try {
    const progress = await composeRunProgress(scope, runId);
    if (!progress) return;
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
    await stub.setState(progress, "progress");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`broadcastRunProgress(${runId}) failed: ${message}`);
  }
}
