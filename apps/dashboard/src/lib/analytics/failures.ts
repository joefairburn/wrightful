import { and, asc, db, desc, eq, gte, inArray, isNotNull, sql } from "void/db";
import { runs, testResults } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import { numericSql } from "@/lib/db/sql-ops";
import { childProjectScopeWhere, type TenantScope } from "@/lib/scope";

/**
 * Cross-run failure clustering, keyed on the ingest-persisted
 * `testResults.errorSignature` fingerprint (see `src/lib/error-signature.ts`).
 * These loaders back the Failures page; the run page's new-vs-known badge
 * shares the same first-seen definition through `src/lib/failure-novelty.ts`.
 *
 * All three reads go through the query builder (not `runRows`) so the bigint
 * `createdAt` and int8 aggregates come back as JS numbers via Drizzle's field
 * decoders (`numericSql`), and every one is served by the partial
 * `testResults_project_signature_createdAt_idx`.
 */

export interface SignatureWindowAggregate {
  signature: string;
  /** Failure rows (failed/timedout/flaky finals) carrying this signature in the window. */
  occurrenceCount: number;
  /** Distinct tests that produced this signature in the window. */
  testCount: number;
  /** Newest occurrence inside the window (+ branch filter). */
  lastSeenAt: number;
}

/**
 * Per-signature aggregate over the window: one row per distinct signature with
 * occurrence/test counts and the newest in-window occurrence. CI-only (the
 * `ciRunsJoinOn` synthetic exclusion) like every analytics surface, ordered
 * most-frequent first. Returns ALL window signatures — the loader slices its
 * display page and derives the KPI strip from the full set, mirroring the
 * flaky page's rank-then-slice shape.
 */
export async function loadSignatureAggregates(
  scope: TenantScope,
  opts: { windowStartSec: number; branch: string | null },
): Promise<SignatureWindowAggregate[]> {
  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    isNotNull(testResults.errorSignature),
    gte(testResults.createdAt, opts.windowStartSec),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const rows = await db
    .select({
      signature: testResults.errorSignature,
      occurrenceCount: numericSql(sql`count(*)`),
      testCount: numericSql(sql`count(distinct ${testResults.testId})`),
      // max over a bigint column is int8 too — same string trap as count/sum.
      lastSeenAt: numericSql(sql`max(${testResults.createdAt})`),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .groupBy(testResults.errorSignature)
    .orderBy(
      desc(sql`count(*)`),
      desc(sql`max(${testResults.createdAt})`),
      asc(testResults.errorSignature),
    );
  // `errorSignature` is typed nullable but the isNotNull predicate guarantees
  // a value; narrow instead of casting row-by-row at the call sites.
  return rows.filter(
    (r): r is SignatureWindowAggregate => r.signature !== null,
  );
}

export interface SignatureFirstSeen {
  signature: string;
  firstSeenAt: number;
  firstRunId: string;
}

/**
 * Project-wide first occurrence per signature — when and in which run each
 * fingerprint FIRST appeared in CI history. Deliberately NOT window- or
 * branch-filtered: those filters choose which signatures are shown, not when
 * a failure mode was first seen. Bounded by retention: a signature quiet for
 * longer than the run-retention window resurfaces as new, which is the
 * intended reading (a regression after months IS news).
 */
export async function loadSignatureFirstSeen(
  scope: TenantScope,
  signatures: readonly string[],
): Promise<SignatureFirstSeen[]> {
  if (signatures.length === 0) return [];
  const rows = await db
    .selectDistinctOn([testResults.errorSignature], {
      signature: testResults.errorSignature,
      firstSeenAt: testResults.createdAt,
      firstRunId: testResults.runId,
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    // `distinct on` requires the distinct column to lead the ordering; the
    // createdAt/id ASC tiebreak makes "the" row per signature the earliest one.
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        inArray(testResults.errorSignature, [...signatures]),
      ),
    )
    .orderBy(
      testResults.errorSignature,
      asc(testResults.createdAt),
      asc(testResults.id),
    );
  return rows.filter((r): r is SignatureFirstSeen => r.signature !== null);
}

export interface SignatureExample {
  signature: string;
  testResultId: string;
  runId: string;
  testId: string;
  title: string;
  file: string;
  status: string;
  createdAt: number;
}

/**
 * Newest example row per signature WITHIN the window (+ branch filter), so the
 * row's link target belongs to the view the user filtered to. Fetched only for
 * the displayed slice.
 */
export async function loadSignatureExamples(
  scope: TenantScope,
  signatures: readonly string[],
  opts: { windowStartSec: number; branch: string | null },
): Promise<SignatureExample[]> {
  if (signatures.length === 0) return [];
  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    inArray(testResults.errorSignature, [...signatures]),
    gte(testResults.createdAt, opts.windowStartSec),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const rows = await db
    .selectDistinctOn([testResults.errorSignature], {
      signature: testResults.errorSignature,
      testResultId: testResults.id,
      runId: testResults.runId,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      status: testResults.status,
      createdAt: testResults.createdAt,
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .orderBy(
      testResults.errorSignature,
      desc(testResults.createdAt),
      desc(testResults.id),
    );
  return rows.filter((r): r is SignatureExample => r.signature !== null);
}
