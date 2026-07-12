import { ulid } from "ulid";
import { and, db, eq, gte, sql } from "void/db";
import { env } from "void/env";
import { effectiveTier } from "@/lib/billing/tier";
import { billingEnabled } from "@/lib/config";
import type { BatchExecutor } from "@/lib/db-batch";
import { numericSql } from "@/lib/db/sql-ops";
import {
  artifacts,
  projects,
  runs,
  teams,
  testResults,
  usageCounters,
} from "@schema";

/**
 * Per-team usage metering + quota enforcement.
 *
 * Two layers, deliberately split:
 *
 *   - **Metering** is a live counter (`usageCounters`, one row per team-month)
 *     bumped in the SAME transaction as the ingest write it meters
 *     (`usageBumpStatement`, wired into `openRun` for `runs` and
 *     `registerArtifacts` for `artifactBytes`/`artifactCount`). Atomic with the
 *     data, no extra round-trip. Counts FRESH rows only (a new run, newly-inserted
 *     artifacts) so an idempotent re-stream/re-registration doesn't double-count.
 *     The `testResults` dimension is the exception: not bumped on the /results
 *     hot path (that upsert serialized every concurrent flush of a team on the
 *     single team-month row) and never quota-gated. It's derived on read
 *     instead (`countTeamTestResults`, called by `checkQuota` and the usage
 *     page's own `defer()`, kept out of `loadTeamUsage` so its `count(*)` scan
 *     can't gate the cheap runs/artifact meters) and re-based by `rollup-usage`.
 *
 *   - **Enforcement** is a read-then-gate (`checkQuota`) at the cheap entry
 *     points, compared against the team's `tier` limits. The runs dimension is
 *     gated at `POST /api/runs`; artifact bytes inside `registerArtifacts` (on
 *     fresh bytes). testResults is surfaced (derived on read) but not hard-blocked.
 *
 * The window is a UTC calendar month: `periodStart` (start-of-month
 * epoch-seconds) keys the counter, so a new month lands on a fresh row via the
 * upsert — no reset job. The `rollup-usage` cron recomputes a period's counters
 * from the authoritative rows to correct any drift (e.g. retention deletes).
 */

/** Human-readable byte count (binary units). PURE — used by the usage page. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** UTC start-of-month epoch-seconds for the month containing `nowSeconds`. PURE. */
export function monthStartSeconds(nowSeconds: number): number {
  const d = new Date(nowSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

export type QuotaDimension = "runs" | "testResults" | "artifactBytes";
export type QuotaStatus = "ok" | "softWarn" | "blocked";

export interface TierLimits {
  runs: number;
  testResults: number;
  artifactBytes: number;
}

/**
 * Limit set for a tier, the only place tiers are interpreted. Billing off
 * (`!billingEnabled(env)`, the OSS/self-host default) is the only uncapped path:
 * every tier is unlimited. With billing on, `'pro'` (incl. trial-pro) reads the
 * high, configurable finite `WRIGHTFUL_PRO_*` ceilings; every other value —
 * `'free'` and any unrecognized/corrupt string — reads `WRIGHTFUL_FREE_*`, so
 * unknown tiers fail closed to the low cap. Pro is enforced like free
 * (soft-warn-then-block), just at a higher ceiling.
 */
export function tierLimits(tier: string): TierLimits {
  // OSS / self-host: billing unconfigured → no caps for anyone. The only unlimited path.
  if (!billingEnabled(env)) {
    return { runs: Infinity, testResults: Infinity, artifactBytes: Infinity };
  }
  if (tier === "pro") {
    // pro (incl. trial-pro): high, configurable FINITE caps (was Infinity).
    return {
      runs: env.WRIGHTFUL_PRO_MONTHLY_RUNS,
      testResults: env.WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS,
      artifactBytes: env.WRIGHTFUL_PRO_ARTIFACT_BYTES,
    };
  }
  // 'free', and any unrecognized/corrupt tier value: fail closed to the Free caps.
  return {
    runs: env.WRIGHTFUL_FREE_MONTHLY_RUNS,
    testResults: env.WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS,
    artifactBytes: env.WRIGHTFUL_FREE_ARTIFACT_BYTES,
  };
}

/**
 * Classify `used + amount` against `limit`. PURE — the load-bearing decision,
 * unit-tested directly. An infinite (non-free-tier) limit is always `ok`;
 * exceeding the limit `blocked`; crossing `softWarnPct` of it `softWarn`.
 * Boundary: exactly `limit` is allowed (block is strictly `>`), so a 1000-run
 * limit permits runs 1..1000 and blocks the 1001st.
 */
export function evaluateQuota(
  used: number,
  amount: number,
  limit: number,
  softWarnPct: number,
): QuotaStatus {
  if (!Number.isFinite(limit)) return "ok";
  const projected = used + amount;
  if (projected > limit) return "blocked";
  if (projected >= (limit * softWarnPct) / 100) return "softWarn";
  return "ok";
}

export interface UsageDelta {
  runs?: number;
  artifactBytes?: number;
  artifactCount?: number;
}

/**
 * The metering statement: upsert this team-month's counter, incrementing each
 * dimension by its delta. Built as a Drizzle statement (NOT awaited) so callers
 * append it to their existing transaction — usage is bumped atomically with the
 * ingest write it meters. A fresh month inserts a new row; an existing one is
 * incremented via `onConflictDoUpdate` on the `(teamId, periodStart)` unique
 * index. Returns `null` for a no-op delta so callers can skip appending it.
 */
export function usageBumpStatement(
  teamId: string,
  periodStart: number,
  delta: UsageDelta,
  nowSeconds: number,
  exec: BatchExecutor,
) {
  const runsDelta = delta.runs ?? 0;
  const artifactBytesDelta = delta.artifactBytes ?? 0;
  const artifactCountDelta = delta.artifactCount ?? 0;
  if (runsDelta === 0 && artifactBytesDelta === 0 && artifactCountDelta === 0) {
    return null;
  }
  return exec
    .insert(usageCounters)
    .values({
      id: ulid(),
      teamId,
      periodStart,
      runsCount: runsDelta,
      artifactBytes: artifactBytesDelta,
      artifactCount: artifactCountDelta,
      updatedAt: nowSeconds,
    })
    .onConflictDoUpdate({
      target: [usageCounters.teamId, usageCounters.periodStart],
      set: {
        runsCount: sql`${usageCounters.runsCount} + ${runsDelta}`,
        artifactBytes: sql`${usageCounters.artifactBytes} + ${artifactBytesDelta}`,
        artifactCount: sql`${usageCounters.artifactCount} + ${artifactCountDelta}`,
        updatedAt: nowSeconds,
      },
    });
}

export interface QuotaResult {
  status: QuotaStatus;
  dimension: QuotaDimension;
  used: number;
  limit: number;
}

/**
 * Read the team's tier + current-period usage for one dimension and classify
 * whether `amount` more is allowed. One indexed query (teams left-joined to the
 * period's counter); a team with no counter row yet reads as zero usage.
 */
export async function checkQuota(
  teamId: string,
  dimension: QuotaDimension,
  amount: number,
  nowSeconds: number,
): Promise<QuotaResult> {
  const periodStart = monthStartSeconds(nowSeconds);
  const rows = await db
    .select({
      tier: teams.tier,
      currentPeriodEnd: teams.currentPeriodEnd,
      runsCount: usageCounters.runsCount,
      artifactBytes: usageCounters.artifactBytes,
    })
    .from(teams)
    .leftJoin(
      usageCounters,
      and(
        eq(usageCounters.teamId, teams.id),
        eq(usageCounters.periodStart, periodStart),
      ),
    )
    .where(eq(teams.id, teamId))
    .limit(1);
  const row = rows[0];
  const tier = effectiveTier(
    row?.tier ?? "free",
    row?.currentPeriodEnd ?? null,
    nowSeconds,
  );
  const limit = tierLimits(tier)[dimension];
  // testResults has no stored counter (dropped — schema-rework-plan Phase 3); it
  // is derived on read. No hot path gates on it today (only `runs` and
  // `artifactBytes` call checkQuota), so the derive runs only if a caller ever
  // asks for the `testResults` dimension.
  const used =
    dimension === "runs"
      ? (row?.runsCount ?? 0)
      : dimension === "artifactBytes"
        ? (row?.artifactBytes ?? 0)
        : await countTeamTestResults(teamId, periodStart);
  const status = evaluateQuota(
    used,
    amount,
    limit,
    env.WRIGHTFUL_QUOTA_SOFT_WARN_PCT,
  );
  return { status, dimension, used, limit };
}

/**
 * Current-period usage excluding testResults — that dimension loads separately
 * via {@link countTeamTestResults} (a `defer()`ed prop) so its heavier
 * `count(*)` scan never gates the cheap `runsCount`/`artifactBytes` meters.
 */
export interface TeamUsage {
  tier: string;
  periodStart: number;
  runsCount: number;
  artifactBytes: number;
  artifactCount: number;
  limits: TierLimits;
}

/**
 * Live count of a team's test-result rows in the billing period containing
 * `periodStart`, computed from the authoritative `testResults` rows (scoped to
 * the team via their projects). testResults is metered for DISPLAY only — it is
 * never quota-gated — so rather than bump a `usageCounters` row on every
 * /results flush (which serialized the whole team on one row), the count is
 * derived on read here and by {@link reconcileUsage}. Backed by
 * `testResults_project_createdAt_idx`. `numericSql` wraps the `count(*)` so the
 * node-postgres int8-as-string result is coerced to a number (pglite returns a
 * number already; the cast keeps both lanes in agreement).
 */
export async function countTeamTestResults(
  teamId: string,
  periodStart: number,
): Promise<number> {
  const teamProjectIds = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, teamId));
  const rows = await db
    .select({ n: numericSql(sql`count(*)`) })
    .from(testResults)
    .where(
      and(
        gte(testResults.createdAt, periodStart),
        sql`${testResults.projectId} in ${teamProjectIds}`,
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Current-period usage (runs + artifact bytes/count, live counters) + tier
 * limits for the usage settings page. Omits `testResultsCount` — that has no
 * live counter (module doc) so deriving it costs a `count(*)` fact-table scan;
 * the page loads it separately via {@link countTeamTestResults} in its own
 * `defer()`, letting this cheap indexed query paint the meters first.
 */
export async function loadTeamUsage(
  teamId: string,
  nowSeconds: number,
): Promise<TeamUsage> {
  const periodStart = monthStartSeconds(nowSeconds);
  const rows = await db
    .select({
      tier: teams.tier,
      currentPeriodEnd: teams.currentPeriodEnd,
      runsCount: usageCounters.runsCount,
      artifactBytes: usageCounters.artifactBytes,
      artifactCount: usageCounters.artifactCount,
    })
    .from(teams)
    .leftJoin(
      usageCounters,
      and(
        eq(usageCounters.teamId, teams.id),
        eq(usageCounters.periodStart, periodStart),
      ),
    )
    .where(eq(teams.id, teamId))
    .limit(1);
  const row = rows[0];
  // Effective tier so the usage page's displayed limits match enforcement
  // (an expired pro reads free caps; trial-pro keeps the finite Pro caps).
  const tier = effectiveTier(
    row?.tier ?? "free",
    row?.currentPeriodEnd ?? null,
    nowSeconds,
  );
  return {
    tier,
    periodStart,
    runsCount: row?.runsCount ?? 0,
    artifactBytes: row?.artifactBytes ?? 0,
    artifactCount: row?.artifactCount ?? 0,
    limits: tierLimits(tier),
  };
}

/** Counts a usage-rollup reconciliation pass emits. */
export interface ReconcileUsageResult {
  teamsReconciled: number;
}

// Postgres's per-statement bound-param ceiling (65535). Mirrors the chunking
// idiom in `src/lib/ingest.ts`, duplicated locally rather than imported to
// avoid a cycle (`ingest.ts` already imports from this module).
const USAGE_PG_MAX_BOUND_PARAMS = 65_535;

/**
 * Chunk `usageCounters` upsert rows so a single `.values(chunk)` stays under
 * the bound-param ceiling, deriving the per-row column count from the row shape
 * (so it can't drift). Pre-launch this is virtually always one chunk.
 */
function chunkUsageCounterRows<T extends Record<string, unknown>>(
  rows: T[],
): T[][] {
  if (rows.length === 0) return [];
  const perChunk = Math.floor(
    USAGE_PG_MAX_BOUND_PARAMS / Object.keys(rows[0]).length,
  );
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) {
    chunks.push(rows.slice(i, i + perChunk));
  }
  return chunks;
}

/**
 * Recompute every team's current-period counters from the authoritative
 * `runs` / `artifacts` rows and overwrite the live counter (testResults has no
 * live counter to reconcile — see the module doc). The live in-batch counters
 * can drift from truth — chiefly when a retention sweep deletes rows inside
 * the current window — so this is the safety net that re-bases them.
 *
 * Set-based, not a per-team loop: two aggregate queries (each `teams LEFT JOIN
 * …`, so a team with no current-period activity still gets a zero-count row —
 * that rebase-to-zero after a retention delete is the point) plus one bulk
 * upsert. The joins stay in separate queries: chaining `runs` and `artifacts`
 * off the same `teams` row would fan out (each run × each artifact per team),
 * corrupting both counts.
 *
 * Pre-launch this recomputes all teams in one pass (team count is tiny). When
 * the fleet grows this should switch to a bounded slice like `sweepStaleRuns`.
 */
export async function reconcileUsage(
  nowSeconds: number,
): Promise<ReconcileUsageResult> {
  const periodStart = monthStartSeconds(nowSeconds);

  // Runs scope to a team directly. Period filter in the JOIN's ON clause (not
  // a WHERE) so an unmatched team keeps its zero-count row instead of dropping.
  const runCountRows = await db
    .select({
      teamId: teams.id,
      runsCount: numericSql(sql`count(${runs.id})`),
    })
    .from(teams)
    .leftJoin(
      runs,
      and(eq(runs.teamId, teams.id), gte(runs.createdAt, periodStart)),
    )
    .groupBy(teams.id);

  // Artifacts scope to a team through their project: teams LEFT JOIN projects
  // (unconditional) LEFT JOIN artifacts (period filter in ON, as above).
  const artifactRows = await db
    .select({
      teamId: teams.id,
      artifactBytes: numericSql(sql`coalesce(sum(${artifacts.sizeBytes}), 0)`),
      artifactCount: numericSql(sql`count(${artifacts.id})`),
    })
    .from(teams)
    .leftJoin(projects, eq(projects.teamId, teams.id))
    .leftJoin(
      artifacts,
      and(
        eq(artifacts.projectId, projects.id),
        gte(artifacts.createdAt, periodStart),
      ),
    )
    .groupBy(teams.id);

  const artifactsByTeam = new Map(artifactRows.map((r) => [r.teamId, r]));

  const rows = runCountRows.map((r) => {
    const art = artifactsByTeam.get(r.teamId);
    return {
      id: ulid(),
      teamId: r.teamId,
      periodStart,
      runsCount: r.runsCount,
      artifactBytes: art?.artifactBytes ?? 0,
      artifactCount: art?.artifactCount ?? 0,
      updatedAt: nowSeconds,
    };
  });

  // Each row's SET differs, so the upsert reads new values from `excluded`
  // (Postgres's alias for the proposed INSERT row), not a shared literal — the
  // multi-row `onConflictDoUpdate` idiom `src/lib/ingest.ts` also uses.
  for (const chunk of chunkUsageCounterRows(rows)) {
    await db
      .insert(usageCounters)
      .values(chunk)
      .onConflictDoUpdate({
        target: [usageCounters.teamId, usageCounters.periodStart],
        set: {
          runsCount: sql`excluded."runsCount"`,
          artifactBytes: sql`excluded."artifactBytes"`,
          artifactCount: sql`excluded."artifactCount"`,
          updatedAt: sql`excluded."updatedAt"`,
        },
      });
  }

  return { teamsReconciled: rows.length };
}
