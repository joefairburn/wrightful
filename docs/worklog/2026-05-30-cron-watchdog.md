# 2026-05-30 — Cron watchdog: liveness signal, bounded sweep, silent no-op finalize

Cluster `cron-watchdog` (findings F80, F81, F82). Turns the stuck-run watchdog
from a `createdAt`-keyed, unbounded, serial, sometimes-redundant sweep into a
liveness-keyed, budgeted, bounded-concurrency, idempotent one — with the
behaviour concentrated behind small seams in `src/lib/scope.ts` and
`src/lib/ingest.ts` that are now unit-tested.

Per-finding worklogs with the full narrative live alongside this entry:

- `2026-05-30-f81-bounded-watchdog-sweep.md`
- `2026-05-30-f82-silent-noop-finalize.md`

## What changed

### F80 — liveness signal instead of open-time (`lastActivityAt`)

The watchdog keyed "stuck?" off `runs.createdAt` (fixed at open), so a live,
actively-streaming long suite was indistinguishable from a process that died at
`onBegin` — once it crossed the wall-clock window since open, it got
force-flipped to `interrupted` while still POSTing results.

Replaced the open-time signal with a real liveness timestamp:

- New nullable `runs.lastActivityAt` column (epoch seconds). Seeded to
  `createdAt` at open (so an `onBegin`-only dead run is still sweepable) and
  bumped to "now" in the **same D1 batch** as every subsequent ingest write —
  `/results` (`aggregateDeltaStatement` and the new liveness-only
  `activityBumpStatement`), `/complete` (`completeRun`'s status UPDATE), and the
  watchdog's own `finalizeStaleRun` flip. No extra round-trip on any path.
- `staleRunFilter(cutoffSeconds)` in `src/lib/scope.ts` is now the single
  definition of "this run is stuck": `status = 'running' AND
coalesce(lastActivityAt, createdAt) < cutoff`. The `coalesce` keeps a
  pre-column NULL row comparable so a truly-dead run is still swept rather than
  skipped forever.

The no-delta `/results` branch deliberately switched from a read-only summary
SELECT to `activityBumpStatement` (an UPDATE with the same `.returning()` shape)
so even a zero-bucket-change flush registers as liveness.

### F81 — bounded, budgeted sweep (`sweepStaleRuns` / `drainStaleRuns`)

The cron previously selected **every** stale run (no `LIMIT`) and finalized them
strictly serially. Each `finalizeStaleRun` is ~2 serial round-trips, so a
mass-stranding event (an ingest outage stranding thousands of runs at
`status='running'`) would make the watchdog self-DoS — the Workers
subrequest/CPU budget runs out mid-drain and the invocation is killed.

- `sweepStaleRuns({ cutoffSeconds, limit, now })` owns the budget/concurrency/
  counting policy: runs the `staleRunFilter` SELECT with `.limit(limit)` (the
  load-bearing budget), then delegates the drain. Returns
  `{ found, finalized, failed }`.
- `drainStaleRuns(staleRuns, finalize, { chunkSize, onError })` is the **pure
  orchestrator** — takes already-selected rows + a per-run finalizer (never
  touches D1), drains them in bounded-concurrency `Promise.allSettled` waves,
  tolerates one stuck run's rejection without aborting the pass, and tallies the
  outcome. This is the unit-test surface.
- Fixed-size slicing extracted to `chunkBySize(items, size)`; `chunkByParams`
  now delegates to it, and `drainStaleRuns` reuses it for the concurrency wave —
  one home for chunking.
- The cron is now a thin adapter: maps env in, logs the tally out.

### F82 — silent no-op finalize (`reconcileAndBroadcast` + `requireStatusFlip`)

In the shared terminal tail, `finalizeStaleRun`'s status flip is guarded on
`status='running'`, but the recompute it batches with is keyed only on
`(projectId, runId)`. So an overlapping cron pass (or a `/complete` that won the
race) would match 0 rows on the guarded flip yet still recompute and broadcast a
redundant terminal progress event.

- `reconcileAndBroadcast(runId, statusUpdate, recomputeScope, opts?)` is the
  terminal tail shared by `completeRun` and `finalizeStaleRun`: status-flip
  FIRST, `aggregateRecomputeStatement` LAST, one `db.batch`, then broadcast.
- `statementChangedRows(batchResult)` is the single typed home for reading a
  non-`.returning()` statement's `meta.changes` from a batch result — the
  head-of-batch counterpart to `summaryFromBatchResults`.
- `opts.requireStatusFlip` gates the broadcast on the flip having changed a row.
  `finalizeStaleRun` sets it (a guarded flip that matched 0 rows stays silent —
  the DB is already correct, only the duplicate live event + round-trip is
  spared); `completeRun` leaves it off (its flip always matches the owned row).

## Details

| Change                                                                                                                             | File                                                | Why                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs.lastActivityAt` (nullable integer) + `runs_status_lastActivityAt_idx` on `(status, lastActivityAt)`                          | `db/schema.ts`                                      | Liveness signal + an index so the sweep SELECT seeks straight to `running` rows instead of a status-filtered table scan (all other `runs` indexes are `projectId`-first). |
| Migrations `20260530180525_naive_proudstar.sql` (add column) + `20260530181157_fancy_screwball.sql` (add index)                    | `db/migrations/` + `meta/_journal.json` + snapshots | Two additive migrations, generated via `void db generate`, applied on deploy. Column migration precedes the index migration.                                              |
| `staleRunFilter` re-keyed to `coalesce(lastActivityAt, createdAt)`                                                                 | `src/lib/scope.ts`                                  | Single definition of "stuck"; the next reader can't re-derive it from `createdAt` and re-introduce the live-run false positive.                                           |
| `lastActivityAt` bumped in `aggregateDeltaStatement`, new `activityBumpStatement`, `completeRun`'s flip, `finalizeStaleRun`'s flip | `src/lib/ingest.ts`                                 | Every ingest write advances liveness in its own existing statement — no extra round-trip. No-delta `/results` now bumps via UPDATE rather than a read-only SELECT.        |
| `chunkBySize` extracted; `chunkByParams` delegates                                                                                 | `src/lib/ingest.ts`                                 | One home for fixed-size slicing, reused by the concurrency wave.                                                                                                          |
| `sweepStaleRuns` + `drainStaleRuns` + `SweepStaleRunsResult`; `STALE_RUN_FINALIZE_CONCURRENCY = 10`                                | `src/lib/ingest.ts`                                 | Budget/concurrency/counting policy; the pure orchestrator is the unit-test surface.                                                                                       |
| `WRIGHTFUL_SWEEP_BATCH_SIZE` (default 200)                                                                                         | `env.ts`                                            | The per-invocation drain cap (well under the subrequest cap at ~2 round-trips/run).                                                                                       |
| `reconcileAndBroadcast` + `statementChangedRows` + `requireStatusFlip`                                                             | `src/lib/ingest.ts`                                 | Shared terminal tail; suppresses the redundant broadcast on a no-op finalize.                                                                                             |
| Cron reduced to a thin adapter over `sweepStaleRuns`                                                                               | `crons/sweep-stuck-runs.ts`                         | Removed inline `db.select` / serial loop / try-catch; docstring re-grounded on the liveness signal + bounded drain.                                                       |

## Scope note

Per the per-finding verifier corrections, F81/F82 are **robustness fixes for the
watchdog's own failure modes** (mass-stranding self-DoS; redundant broadcast on
an overlapping/raced finalize), not N≥2 smeared-complexity deepenings —
`finalizeStaleRun` has one caller today. The seams are "one tidy home for the
budget/terminal-tail policy" the cron would otherwise inline. F80 is the
substantive correctness fix (no more force-interrupting live suites). Severity
medium overall: the system isn't deployed yet and the high-impact cases need a
multi-tenant ingest outage / concurrent-finalize race.

## Tests

- `src/__tests__/drain-stale-runs.test.ts` — pins the pure `drainStaleRuns`
  orchestrator against a fake finalizer: full drain + tally, empty batch,
  bounded concurrency (`maxInFlight <= chunkSize`), partial-failure tolerance
  (one rejecting run never aborts the pass), per-failure `onError` with the
  offending run, optional `onError`.
- `src/__tests__/scope-where.test.ts` — `staleRunFilter` shape: keys off
  `coalesce(lastActivityAt, createdAt)`, gated on `status = 'running'`.
- `src/__tests__/reconcile-and-broadcast.test.ts` — `statementChangedRows`
  (`meta.changes` extraction, missing-shape ⇒ 0) and the `requireStatusFlip`
  no-op-suppression branch.
- `src/__tests__/summary-from-batch.test.ts` — extended for the
  recompute-last-row summary convention shared by the terminal tail.
- `src/__tests__/chunk-insert-rows.test.ts` — `chunkBySize` block (consecutive
  chunks, empty array, size ≥ length, non-positive size ⇒ no infinite loop).
- `src/__tests__/ingest-pipeline.test.ts` — updated for the `lastActivityAt`
  bump on the delta / no-delta paths.

`sweepStaleRuns` itself (the D1 SELECT) and the SQL-side statements
(`activityBumpStatement`, the merge/recompute UPDATEs) are not unit-testable —
the dashboard vitest harness stubs `void/db` — so they stay thin over the tested
pure functions. Integration gap noted.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (codegen + tsgo, 0 errors).
- `pnpm --filter @wrightful/dashboard test` — 528 passed / 43 files.
- `pnpm --filter @wrightful/reporter test` — 176 passed / 13 files.
- `pnpm check` — 0 errors, 84 warnings (all pre-existing e2e warnings, unrelated).
- Migration journal + snapshots regenerated consistently; the `lastActivityAt`
  column migration precedes the index migration.
