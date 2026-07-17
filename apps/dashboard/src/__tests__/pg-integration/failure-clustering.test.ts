// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

const { resetTables } = await import("./harness");
const { failureSignature } = await import("@/lib/error-signature");
const { loadSignatureAggregates, loadSignatureExamples } =
  await import("@/lib/analytics/failures");
const { loadNewFailureFlags } = await import("@/lib/failure-novelty");
const { makeTenantScope } = await import("@/lib/scope");
const { runs, testResults } = await import("../../../db/schema");

const NOW = 1_800_000_000;
/** Window opens between run_old and run_recent — sigA's history predates it. */
const WINDOW_START = NOW - 500;
const scope = makeTenantScope({
  teamId: "team_failures",
  projectId: "project_failures",
  teamSlug: "acme",
  projectSlug: "web",
});

// Two distinct fingerprints, seeded through the same normalize path ingest
// uses so the expected grouping keys are the real ones.
const URL_ERROR =
  "Error: expect(page).toHaveURL(expected) failed after 30000ms";
const CONN_ERROR = "Error: connect ECONNREFUSED 127.0.0.1:5432";
const URL_SIG = failureSignature("failed", URL_ERROR, null)!;
const CONN_SIG = failureSignature("failed", CONN_ERROR, null)!;

function run(id: string, createdAt: number, origin = "ci") {
  return {
    id,
    teamId: scope.teamId,
    projectId: scope.projectId,
    totalTests: 2,
    passed: 0,
    failed: 2,
    flaky: 0,
    skipped: 0,
    durationMs: 1000,
    status: "failed",
    branch: "main",
    commitSha: `sha_${id}`,
    createdAt,
    lastActivityAt: createdAt,
    completedAt: createdAt + 10,
    origin,
  };
}

function result(
  id: string,
  runId: string,
  testId: string,
  status: string,
  createdAt: number,
  errorMessage: string | null = null,
) {
  return {
    id,
    projectId: scope.projectId,
    runId,
    testId,
    title: `${testId} title`,
    file: `tests/${testId}.spec.ts`,
    projectName: "chromium",
    status,
    durationMs: 1000,
    retryCount: 0,
    errorMessage,
    errorStack: null,
    errorSignature: failureSignature(status, errorMessage, null),
    workerIndex: 0,
    shardIndex: null,
    createdAt,
    updatedAt: createdAt,
  };
}

beforeAll(async () => {
  await resetTables(h.client, [runs, testResults]);
  await h.db
    .insert(runs)
    .values([
      run("run_old", NOW - 800),
      run("run_recent", NOW - 200),
      run("run_current", NOW - 100),
      run("run_synthetic", NOW - 150, "synthetic"),
      run("run_synth_old", NOW - 900, "synthetic"),
    ]);
  await h.db.insert(testResults).values([
    // sigA (URL_SIG): known — first seen in run_old, BEFORE the window.
    result(
      "res_old_a",
      "run_old",
      "test_login",
      "failed",
      NOW - 800,
      URL_ERROR,
    ),
    result(
      "res_recent_a",
      "run_recent",
      "test_login",
      "timedout",
      NOW - 200,
      URL_ERROR,
    ),
    result(
      "res_current_a",
      "run_current",
      "test_checkout",
      "failed",
      NOW - 100,
      URL_ERROR,
    ),
    // sigB (CONN_SIG): new — first-ever occurrence is inside run_current.
    result(
      "res_current_b",
      "run_current",
      "test_cart",
      "failed",
      NOW - 100,
      CONN_ERROR,
    ),
    // Non-failures and errorless failures carry no signature.
    result("res_current_pass", "run_current", "test_nav", "passed", NOW - 100),
    result(
      "res_current_noerr",
      "run_current",
      "test_misc",
      "failed",
      NOW - 100,
    ),
    // Synthetic monitor traffic must not reach any clustering surface.
    result(
      "res_synth",
      "run_synthetic",
      "test_monitor",
      "failed",
      NOW - 150,
      "Error: synthetic-only failure",
    ),
    // sigA also failed in an EARLIER synthetic run — must not drag the
    // project-wide first-seen (a CI-only min) back to NOW - 900.
    result(
      "res_synth_old_a",
      "run_synth_old",
      "test_monitor",
      "failed",
      NOW - 900,
      URL_ERROR,
    ),
  ]);
});

afterAll(async () => {
  await h.client.close();
});

describe("failure clustering Postgres queries", () => {
  it("aggregates window signatures as JS numbers, CI-only, most-frequent first", async () => {
    const aggregates = await loadSignatureAggregates(scope, {
      windowStartSec: WINDOW_START,
      branch: null,
    });

    expect(aggregates.map((a) => a.signature)).toEqual([URL_SIG, CONN_SIG]);
    const urlAgg = aggregates[0]!;
    // res_old_a is outside the window; res_synth is synthetic — both excluded.
    // firstSeenAt is project-wide (run_old, outside the window) but CI-only:
    // the older synthetic occurrence at NOW - 900 must not drag it back.
    expect(urlAgg).toMatchObject({
      occurrenceCount: 2,
      testCount: 2,
      lastSeenAt: NOW - 100,
      firstSeenAt: NOW - 800,
    });
    // sigB's first-ever CI occurrence is inside the window → the "New" case.
    expect(aggregates[1]).toMatchObject({ firstSeenAt: NOW - 100 });
    // Pins the int8/bigint coercion: node-postgres returns these as strings
    // without the numericSql decoders.
    expect(typeof urlAgg.occurrenceCount).toBe("number");
    expect(typeof urlAgg.testCount).toBe("number");
    expect(typeof urlAgg.lastSeenAt).toBe("number");
    expect(typeof urlAgg.firstSeenAt).toBe("number");
  });

  it("filters the aggregate by branch", async () => {
    const aggregates = await loadSignatureAggregates(scope, {
      windowStartSec: WINDOW_START,
      branch: "other-branch",
    });
    expect(aggregates).toEqual([]);
  });

  it("returns the newest in-window example row per signature", async () => {
    const examples = await loadSignatureExamples(scope, [URL_SIG, CONN_SIG], {
      windowStartSec: WINDOW_START,
      branch: null,
    });
    const bySig = new Map(examples.map((r) => [r.signature, r]));

    expect(bySig.get(URL_SIG)).toMatchObject({
      testResultId: "res_current_a",
      runId: "run_current",
      testId: "test_checkout",
      status: "failed",
    });
    expect(bySig.get(CONN_SIG)).toMatchObject({
      testResultId: "res_current_b",
      runId: "run_current",
    });
  });

  const pageRow = (id: string, status: string) => ({
    id,
    testId: `t_${id}`,
    title: "t",
    file: "f",
    projectName: null,
    status,
    durationMs: 0,
    retryCount: 0,
    shardIndex: null,
  });

  it("classifies a run page's failures as new vs known by signature history", async () => {
    const flags = await loadNewFailureFlags(scope, "run_current", [
      pageRow("res_current_a", "failed"),
      pageRow("res_current_b", "failed"),
      pageRow("res_current_pass", "passed"),
      pageRow("res_current_noerr", "failed"),
    ]);

    // sigA appeared in run_old → known; sigB's first appearance is this run.
    expect(flags.get("res_current_a")).toBe(false);
    expect(flags.get("res_current_b")).toBe(true);
    // Unclassifiable rows (no signature) stay absent, not false.
    expect(flags.has("res_current_pass")).toBe(false);
    expect(flags.has("res_current_noerr")).toBe(false);
  });

  it("never classifies a synthetic run's rows — novelty is a CI concept", async () => {
    // Without the origin gate this recurring monitor failure (no CI history)
    // would badge "New" on every monitor execution forever.
    const flags = await loadNewFailureFlags(scope, "run_synthetic", [
      pageRow("res_synth", "failed"),
    ]);
    expect(flags.size).toBe(0);
  });
});
