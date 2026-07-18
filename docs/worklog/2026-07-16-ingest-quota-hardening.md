# 2026-07-16 — Ingest contract edges + quota enforcement hardening

Seven correctness fixes on the streaming-ingest path: two on quota metering
(atomicity + rollup race), one compensating abuse cap, and four on the
reporter↔dashboard wire contract. No schema changes (all caps enforced in the
validation/ingest layer).

## What changed

### 1. Atomic quota enforcement — runs + artifactBytes (was read-then-gate TOCTOU)

`checkQuota` reads the counter OUTSIDE the metering transaction, so K parallel
`POST /api/runs` or `/api/artifacts/register` could each pass the boundary and
overshoot ~K×.

- Added `usageGuardedBumpStatement` (`src/lib/usage.ts`): the same upsert as
  `usageBumpStatement` but the `DO UPDATE` carries a `setWhere` guard
  (`<col> + <delta> <= <limit>`) and `.returning()`s. A gate+increment in ONE
  atomic statement — an EMPTY return means the increment would exceed the cap.
  Non-finite limit (billing off) → plain unconditional bump.
- `registerArtifacts` (`src/lib/artifacts.ts`): replaced `runBatch` with an
  explicit `db.transaction` so the guarded bump's `.returning()` can be inspected
  and the whole write rolled back; an empty return throws a private
  `ArtifactQuotaOvershootError` → `quotaExceeded` (429).
- `openRun` (`src/lib/ingest.ts`): new optional `opts.runsQuotaLimit`; the
  fresh-open path now runs a direct `db.transaction` (run insert + prefill +
  catalog + guarded bump) and throws the exported `RunQuotaOvershootError` on
  overshoot. The `POST /api/runs` handler threads `quota.limit` and maps that
  error to the same 429. Synthetic-monitor opens pass no limit → exempt,
  unchanged. `checkQuota` is retained as the fast reject + soft-warn signal AND
  the fresh-month over-cap catch; the guard closes only the concurrent-overshoot
  race on the existing row. The two together are exact.

### 2. `reconcileUsage` rollup no longer clobbers live bumps

The daily rollup recomputed from `runs`/`artifacts` then bulk-upserted
`SET = excluded` (absolute overwrite), erasing any ingest bump committed between
the aggregate SELECTs and the upsert (≤24h undercount). Switched to
`greatest(existing, excluded)`. The recompute is a lower bound; a concurrent bump
only ever raises the truth, so max() keeps counters monotonic and never
under-reports. Tradeoff (documented in code): no longer rebases DOWN, which is
acceptable for the current period — `runs` are never retention-deleted and the
retention windows (artifacts ≥30d, testResults ≥90d) exceed a calendar month, so
a current-month down-rebase essentially never occurs.

### 3. Per-run testResults row ceiling (compensating cap)

testResults is deliberately never quota-gated, `runClosedForWrites` returns false
while `status='running'`, and every `/results` flush re-arms liveness — so a
quota-blocked team could stream rows indefinitely on one open run. Added
`WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN` (env.ts, default 500,000; 0 disables) and a
check in `appendRunResults` off the owner probe's new `totalTests` column
(`RUN_WRITE_GUARD_COLUMNS`). New outcome `rowCapExceeded` → 413 (non-retryable;
reporter drops the batch). Coarse/best-effort (probe outside the lock), giving a
hard upper bound of ~cap + concurrency×MAX_RESULTS_PER_BATCH.

### 4. Reporter clamps `batchSize` + `plannedTests` to dashboard caps

Exported `MAX_RESULTS_PER_BATCH` / `MAX_PLANNED_TESTS` from `schemas.ts`; mirrored
in the reporter's `limits.ts`; `contract.test.ts` pins both === the dashboard
constants. `index.ts` clamps `batchSize` to `[1, MAX_RESULTS_PER_BATCH]` (warn on
over-cap) and truncates `plannedTests` to `MAX_PLANNED_TESTS` (warn) while keeping
the true count on `expectedTotalTests`, so a misconfiguration no longer silently
drops every batch / loses the whole run to a 400.

### 5. Duplicate attempt indices → 400 (was retried 500)

`TestResultSchema.attempts` now refines for unique `attempt` indices — a duplicate
would collide on `testResultAttempts_testResultId_attempt_uq` and 500 the whole
batch (then get retried pointlessly). Non-retryable 400 surfaces the client bug.

### 6. Sharded `/complete` — run-side signal wins

`completeRun`'s deferred-finalize gate dropped the `payload.shard &&` requirement:
if the run was opened sharded (`expectedShards > 1`) it takes the deferred path
regardless of whether THIS `/complete` carries `shard`, so a mixed-version fleet
can't fall to the legacy path and finalize the run terminal while siblings stream.
`completeShardedRun`'s `shard` is now optional — an anonymous complete skips the
`runShards` insert (can't attribute it) and stays a pure liveness bump; the run
finalizes on the identified shards (or the watchdog).

### 7. Shard `index` validated against `total`

`ShardSchema` refines `index <= total`, so a bogus `{index:7,total:4}` can't
satisfy the finalize count early. 400 at the door.

## Files

- `apps/dashboard/src/lib/usage.ts` — `usageGuardedBumpStatement`; reconcile `greatest`.
- `apps/dashboard/src/lib/ingest.ts` — `RunQuotaOvershootError`, guarded open txn,
  `RUN_WRITE_GUARD_COLUMNS.totalTests`, `rowCapExceeded`, sharded gate +
  `completeShardedRun` optional shard.
- `apps/dashboard/src/lib/artifacts.ts` — guarded artifact-byte bump in a
  `db.transaction`.
- `apps/dashboard/src/lib/schemas.ts` — exported batch/planned caps, attempt-index
  refine, shard-range refine.
- `apps/dashboard/routes/api/runs/index.ts` — thread limit + map overshoot to 429.
- `apps/dashboard/routes/api/runs/[id]/results.ts` — `rowCapExceeded` → 413.
- `apps/dashboard/env.ts` — `WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN`.
- `packages/reporter/src/limits.ts`, `index.ts` — client-side clamps.
- `packages/reporter/src/__tests__/contract.test.ts` — cap pins.

## Verification

- `pnpm check` (`vp check`, including `void prepare`, formatting, lint, and
  typecheck) — **0 errors**, 143 existing warnings.
- `pnpm test` — dashboard node lane **660 passed / 4 skipped**, dashboard
  Workers lane **1369 passed**, reporter **304 passed**.
- Focused quota/ingest suites — `usage-atomic`, `ingest-row-cap`,
  `sharded-complete`, `pg-integration/ingest`, `members-billing`, schemas, and
  ingest-pipeline all passed. Coverage now includes first-write quota rejection,
  locked cap crossing/concurrent appends, stale-counter correction, and
  post-snapshot increment preservation.
- The preview/E2E harness was not run; its lock-restoration ordering was covered
  by typecheck and the full unit suites.
