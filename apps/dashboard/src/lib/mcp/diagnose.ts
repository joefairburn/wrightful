import {
  and,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  sql,
} from "void/db";
import { runs, testResultAttempts, testResults, tests } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import {
  rankFlakyTests,
  type RankedFlaky,
} from "@/lib/analytics/flaky-ranking";
import { buildTestSearchWhere } from "@/lib/command-search";
import { normalizeErrorSignature } from "@/lib/error-signature";
import {
  childProjectScopeWhere,
  ciRunsScopeWhere,
  runScopeWhere,
  type TenantScope,
} from "@/lib/scope";

/**
 * Statuses whose rows carry a failure worth fingerprinting and co-relating.
 * Hand-listed like `run-diff.ts`'s FAILING_STATUSES: `interrupted` never
 * appears on the per-test wire enum and `queued`/`skipped` carry no error.
 */
const FAILURE_STATUSES = ["flaky", "failed", "timedout"] as const;

const MAX_WINDOW_ROWS_PER_TEST = 500;
const MAX_CO_FAILURE_RUNS = 200;
/** Hard row cap on the co-failure read — a mass-failure era must not make it unbounded. */
const MAX_CO_FAILURE_ROWS = 5000;
const MAX_CO_FAILURES_PER_TEST = 10;
const MAX_MATCHED_TESTS = 50;
/**
 * Only this many leading chars of an error are fetched: a signature uses the
 * first meaningful line ({@link normalizeErrorSignature}), and ingest allows
 * messages/stacks up to 64/128 KB — pulling those whole for thousands of
 * window rows would swamp Worker memory. Full text stays behind
 * `get_test_result`.
 */
const ERROR_HEAD_CHARS = 2048;

function isFailureStatus(status: string): boolean {
  return (FAILURE_STATUSES as readonly string[]).includes(status);
}

/** Byte-bounded error head, message first, stack as fallback. */
function errorHeadSql() {
  return sql<
    string | null
  >`left(coalesce(${testResults.errorMessage}, ${testResults.errorStack}), ${ERROR_HEAD_CHARS})`;
}

export interface McpFlakyDiagnosisOptions {
  days: number;
  branch: string | null;
  limit: number;
}

/** The single selector `get_test_history` resolves — the tool layer validates "exactly one". */
export interface McpTestHistorySelector {
  kind: "testId" | "file" | "query";
  value: string;
}

export interface McpTestHistoryOptions {
  selector: McpTestHistorySelector;
  days: number;
  branch: string | null;
  limit: number;
}

type WindowRow = Awaited<ReturnType<typeof loadWindowRows>>[number];
type EnrichedRow = WindowRow & { signature: string | null };
type CoFailureRow = Awaited<ReturnType<typeof loadCoFailureRows>>[number];

function windowStart(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

async function loadWindowRows(
  scope: TenantScope,
  testIds: string[],
  opts: McpFlakyDiagnosisOptions,
) {
  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    runScopeWhere(scope),
    inArray(testResults.testId, testIds),
    gte(testResults.createdAt, windowStart(opts.days)),
    ne(testResults.status, "skipped"),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const windowed = db
    .select({
      id: testResults.id,
      runId: testResults.runId,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      status: testResults.status,
      errorHead: errorHeadSql().as("errorHead"),
      createdAt: testResults.createdAt,
      rowNumber:
        sql<number>`cast(row_number() over (partition by ${testResults.testId} order by ${testResults.createdAt} desc, ${testResults.id} desc) as integer)`.as(
          "rowNumber",
        ),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .as("windowed_mcp_results");

  return db
    .select({
      id: windowed.id,
      runId: windowed.runId,
      testId: windowed.testId,
      title: windowed.title,
      file: windowed.file,
      status: windowed.status,
      errorHead: windowed.errorHead,
      createdAt: windowed.createdAt,
    })
    .from(windowed)
    .where(lte(windowed.rowNumber, MAX_WINDOW_ROWS_PER_TEST))
    .orderBy(desc(windowed.createdAt), desc(windowed.id));
}

async function loadCurrentHealth(
  scope: TenantScope,
  testIds: string[],
  branch: string | null,
) {
  const conditions = [ciRunsScopeWhere(scope), isNotNull(runs.completedAt)];
  if (branch) conditions.push(eq(runs.branch, branch));

  const [latestRun] = await db
    .select({
      latestRunId: runs.id,
      latestRunStatus: runs.status,
      branch: runs.branch,
      at: runs.createdAt,
    })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);

  if (!latestRun)
    return { currentHealth: null, statuses: new Map<string, string>() };

  const statusRows = await db
    .select({ testId: testResults.testId, status: testResults.status })
    .from(testResults)
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        eq(testResults.runId, latestRun.latestRunId),
        inArray(testResults.testId, testIds),
      ),
    );

  return {
    currentHealth: latestRun,
    statuses: new Map(statusRows.map((row) => [row.testId, row.status])),
  };
}

async function loadCoFailureRows(scope: TenantScope, runIds: string[]) {
  if (runIds.length === 0) return [];
  return (
    db
      .select({
        runId: testResults.runId,
        testId: testResults.testId,
        title: testResults.title,
      })
      .from(testResults)
      .innerJoin(runs, ciRunsJoinOn())
      .where(
        and(
          childProjectScopeWhere(testResults.projectId, scope),
          runScopeWhere(scope),
          inArray(testResults.runId, runIds),
          inArray(testResults.status, [...FAILURE_STATUSES]),
        ),
      )
      // Newest-first so the row cap drops the oldest failures, not arbitrary ones.
      .orderBy(desc(testResults.createdAt), desc(testResults.id))
      .limit(MAX_CO_FAILURE_ROWS)
  );
}

/** Cross-test context {@link buildTestDossier} reads alongside one test's own rows. */
interface DossierContext {
  /** signature → the selected testIds that produced it in the window. */
  signatureOwners: Map<string, Set<string>>;
  /** The (newest-first) flaky runs co-failure analysis was bounded to. */
  coFailureRunIds: Set<string>;
  flakyRunIdsByTest: Map<string, Set<string>>;
  failuresByRun: Map<string, CoFailureRow[]>;
  /** testId → status in the latest completed CI run. */
  latestStatusByTest: Map<string, string>;
}

/** One test's diagnosis entry, from its (newest-first) window rows + cross-test context. Pure. */
function buildTestDossier(
  rankedRow: RankedFlaky,
  ownRows: EnrichedRow[],
  ctx: DossierContext,
) {
  const latest = ownRows[0];
  const signatureGroups = new Map<
    string,
    { count: number; representativeTestResultId: string }
  >();
  let latestFlakyTestResultId: string | null = null;
  let latestHardFailTestResultId: string | null = null;
  let latestPassedTestResultId: string | null = null;
  let lastFlakyAt: number | null = null;

  for (const row of ownRows) {
    if (row.status === "flaky" && latestFlakyTestResultId === null) {
      latestFlakyTestResultId = row.id;
      lastFlakyAt = row.createdAt;
    }
    if (
      (row.status === "failed" || row.status === "timedout") &&
      latestHardFailTestResultId === null
    ) {
      latestHardFailTestResultId = row.id;
    }
    if (row.status === "passed" && latestPassedTestResultId === null) {
      latestPassedTestResultId = row.id;
    }
    if (!row.signature) continue;
    const group = signatureGroups.get(row.signature);
    signatureGroups.set(row.signature, {
      count: (group?.count ?? 0) + 1,
      representativeTestResultId: group?.representativeTestResultId ?? row.id,
    });
  }

  const coFailureCounts = new Map<
    string,
    { title: string; sharedRuns: number }
  >();
  for (const runId of ctx.flakyRunIdsByTest.get(rankedRow.testId) ?? []) {
    if (!ctx.coFailureRunIds.has(runId)) continue;
    for (const row of ctx.failuresByRun.get(runId) ?? []) {
      if (row.testId === rankedRow.testId) continue;
      const existing = coFailureCounts.get(row.testId);
      coFailureCounts.set(row.testId, {
        title: row.title,
        sharedRuns: (existing?.sharedRuns ?? 0) + 1,
      });
    }
  }

  const hardFailures = rankedRow.hardFailureCount;
  const latestStatus = ctx.latestStatusByTest.get(rankedRow.testId) ?? null;
  return {
    testId: rankedRow.testId,
    title: latest?.title ?? "",
    file: latest?.file ?? "",
    samples: rankedRow.passedCount + rankedRow.flakyCount + hardFailures,
    firstAttemptFailures: rankedRow.flakyCount + hardFailures,
    retryPasses: rankedRow.flakyCount,
    hardFailures,
    passedCount: rankedRow.passedCount,
    flakeRatePct: Math.round(rankedRow.flakeRatePct * 10) / 10,
    lastFlakyAt,
    passedInLatestRun: latestStatus === null ? null : latestStatus === "passed",
    latestStatus,
    representatives: {
      latestFlakyTestResultId,
      latestHardFailTestResultId,
      latestPassedTestResultId,
    },
    signatures: [...signatureGroups.entries()]
      .map(([signature, group]) => ({
        signature,
        count: group.count,
        correlatedTests: Math.max(
          0,
          (ctx.signatureOwners.get(signature)?.size ?? 1) - 1,
        ),
        representativeTestResultId: group.representativeTestResultId,
      }))
      .sort(
        (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
      ),
    coFailures: [...coFailureCounts.entries()]
      .map(([testId, value]) => ({ testId, ...value }))
      .sort(
        (a, b) => b.sharedRuns - a.sharedRuns || a.title.localeCompare(b.title),
      )
      .slice(0, MAX_CO_FAILURES_PER_TEST),
  };
}

/** Heavy, bounded flaky-test dossier behind `diagnose_flaky_tests`. */
export async function loadMcpFlakyDiagnosis(
  scope: TenantScope,
  opts: McpFlakyDiagnosisOptions,
) {
  const ranked = await rankFlakyTests(scope, {
    windowStartSec: windowStart(opts.days),
    branch: opts.branch,
  });
  const selected = ranked.slice(0, opts.limit);
  const base = {
    windowDays: opts.days,
    branch: opts.branch,
    totalFlakyTests: ranked.length,
  };
  if (selected.length === 0) return { ...base, currentHealth: null, tests: [] };

  const testIds = selected.map((row) => row.testId);
  const rows = await loadWindowRows(scope, testIds, opts);

  // One enrichment pass: fingerprint each failure row once, group rows per
  // test, and collect the flaky runs (globally newest-first) that co-failure
  // analysis is bounded to.
  const rowsByTest = new Map<string, EnrichedRow[]>();
  const signatureOwners = new Map<string, Set<string>>();
  const flakyRunIdsByTest = new Map<string, Set<string>>();
  const flakyRunIds = new Set<string>();
  for (const row of rows) {
    const signature = isFailureStatus(row.status)
      ? normalizeErrorSignature(row.errorHead)
      : null;
    const ownRows = rowsByTest.get(row.testId) ?? [];
    ownRows.push({ ...row, signature });
    rowsByTest.set(row.testId, ownRows);
    if (signature) {
      const owners = signatureOwners.get(signature) ?? new Set<string>();
      owners.add(row.testId);
      signatureOwners.set(signature, owners);
    }
    if (row.status === "flaky") {
      flakyRunIds.add(row.runId);
      const runIds = flakyRunIdsByTest.get(row.testId) ?? new Set<string>();
      runIds.add(row.runId);
      flakyRunIdsByTest.set(row.testId, runIds);
    }
  }

  const coFailureRunIds = new Set(
    [...flakyRunIds].slice(0, MAX_CO_FAILURE_RUNS),
  );
  const [coFailureRows, health] = await Promise.all([
    loadCoFailureRows(scope, [...coFailureRunIds]),
    loadCurrentHealth(scope, testIds, opts.branch),
  ]);
  const failuresByRun = new Map<string, CoFailureRow[]>();
  for (const row of coFailureRows) {
    const runRows = failuresByRun.get(row.runId) ?? [];
    runRows.push(row);
    failuresByRun.set(row.runId, runRows);
  }

  const ctx: DossierContext = {
    signatureOwners,
    coFailureRunIds,
    flakyRunIdsByTest,
    failuresByRun,
    latestStatusByTest: health.statuses,
  };
  return {
    ...base,
    currentHealth: health.currentHealth,
    tests: selected.map((rankedRow) =>
      buildTestDossier(rankedRow, rowsByTest.get(rankedRow.testId) ?? [], ctx),
    ),
  };
}

/**
 * Resolve the selector against the `tests` catalog (identity table, one row
 * per test, trigram-indexed — the same table the ⌘K search reads). Ingest
 * catalogs every test atomically with its results, so resolving through it is
 * complete: a testId with results but no catalog row cannot exist.
 */
async function resolveHistoryTests(
  scope: TenantScope,
  selector: McpTestHistorySelector,
) {
  const where =
    selector.kind === "testId"
      ? and(
          childProjectScopeWhere(tests.projectId, scope),
          eq(tests.testId, selector.value),
        )
      : selector.kind === "file"
        ? and(
            childProjectScopeWhere(tests.projectId, scope),
            eq(tests.file, selector.value),
          )
        : buildTestSearchWhere(scope, selector.value);
  return db
    .select({ testId: tests.testId, title: tests.title, file: tests.file })
    .from(tests)
    .where(where)
    .orderBy(desc(tests.lastSeenAt), tests.testId)
    .limit(MAX_MATCHED_TESTS);
}

/** One-call execution and retry timeline behind `get_test_history`. */
export async function loadMcpTestHistory(
  scope: TenantScope,
  opts: McpTestHistoryOptions,
) {
  const matchedTests = await resolveHistoryTests(scope, opts.selector);
  const testIds = matchedTests.map((test) => test.testId);
  if (testIds.length === 0) return { matchedTests, executions: [] };

  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    runScopeWhere(scope),
    inArray(testResults.testId, testIds),
    gte(testResults.createdAt, windowStart(opts.days)),
    ne(testResults.status, "queued"),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const rows = await db
    .select({
      testResultId: testResults.id,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      runId: testResults.runId,
      at: runs.createdAt,
      commit: runs.commitSha,
      branch: runs.branch,
      prNumber: runs.prNumber,
      status: testResults.status,
      durationMs: testResults.durationMs,
      workerIndex: testResults.workerIndex,
      shardIndex: testResults.shardIndex,
      errorHead: errorHeadSql().as("errorHead"),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt), desc(testResults.createdAt), testResults.id)
    .limit(opts.limit);

  if (rows.length === 0) return { matchedTests, executions: [] };
  const attemptRows = await db
    .select({
      testResultId: testResultAttempts.testResultId,
      attempt: testResultAttempts.attempt,
      status: testResultAttempts.status,
      durationMs: testResultAttempts.durationMs,
    })
    .from(testResultAttempts)
    .where(
      and(
        childProjectScopeWhere(testResultAttempts.projectId, scope),
        inArray(
          testResultAttempts.testResultId,
          rows.map((row) => row.testResultId),
        ),
      ),
    )
    .orderBy(testResultAttempts.testResultId, testResultAttempts.attempt);
  const attemptsByResult = new Map<string, typeof attemptRows>();
  for (const attempt of attemptRows) {
    const attempts = attemptsByResult.get(attempt.testResultId) ?? [];
    attempts.push(attempt);
    attemptsByResult.set(attempt.testResultId, attempts);
  }

  return {
    matchedTests,
    executions: rows.map((row) => ({
      testResultId: row.testResultId,
      testId: row.testId,
      title: row.title,
      file: row.file,
      runId: row.runId,
      at: row.at,
      commit: row.commit,
      branch: row.branch,
      prNumber: row.prNumber,
      status: row.status,
      durationMs: row.durationMs,
      attempts: (attemptsByResult.get(row.testResultId) ?? []).map(
        ({ attempt, status, durationMs }) => ({
          attempt,
          status,
          durationMs,
        }),
      ),
      workerIndex: row.workerIndex,
      shardIndex: row.shardIndex,
      errorSignature: normalizeErrorSignature(row.errorHead),
    })),
  };
}
