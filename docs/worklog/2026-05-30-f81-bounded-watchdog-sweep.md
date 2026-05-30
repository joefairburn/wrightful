# 2026-05-30 — F81: bounded, budgeted watchdog sweep (`sweepStaleRuns`)

## What changed

The stuck-run watchdog cron (`crons/sweep-stuck-runs.ts`) previously selected
**every** run matching `staleRunFilter` (no `LIMIT`) and finalized them strictly
serially inside a single scheduled invocation. Each `finalizeStaleRun` is ~2
serial round-trips (a `db.batch` recompute + a `void/live` broadcast), so a
mass-stranding event — an ingest outage leaving thousands of runs stuck at
`status='running'`, which is the exact scenario the watchdog exists for — would
make the cron self-DoS: the Workers subrequest/CPU/wall-time budget runs out
mid-drain, the invocation is killed, and the next invocation re-selects the same
enormous set and dies the same way.

This finding makes the watchdog drain a **bounded slice per invocation**:

- New `sweepStaleRuns({ cutoffSeconds, limit, now })` seam in `src/lib/ingest.ts`
  owns the budget/concurrency/counting policy. It runs the `staleRunFilter`
  SELECT with `.limit(limit)` (the load-bearing budget), then delegates the
  drain. Returns `{ found, finalized, failed }`.
- New `drainStaleRuns(staleRuns, finalize, { chunkSize, onError })` — the **pure
  orchestrator**: takes the already-selected rows and a per-run finalizer as
  parameters (so it never touches D1), drains them in bounded-concurrency
  `Promise.allSettled` waves, tolerates a stuck run's rejection without aborting
  the pass, and tallies the outcome. This is the unit-test surface.
- The cron is now a thin adapter: maps env config in, logs the tally out.

Finalized runs flip to `'interrupted'` (the UPDATE is guarded on
`status='running'` in `finalizeStaleRun`), so they drop out of the next pass's
SELECT and the backlog drains incrementally across successive 5-minute
invocations.

## Scope note

Per the verifier's correction: this is a **robustness fix for the watchdog's own
failure mode**, not an N≥2 smeared-complexity deepening — `finalizeStaleRun` has
exactly one caller today (no admin "reap" endpoint or backfill script exists).
The seam is "one tidy home for the budget policy" that the cron would otherwise
have to inline. Severity medium: the system isn't deployed yet, the fix is small,
and the high-impact case requires a multi-tenant ingest outage.

## Details

| Change                                                                | File                                                            | Why                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunkBySize(items, size)` extracted; `chunkByParams` delegates to it | `src/lib/ingest.ts`                                             | Fixed-size slicing now lives in one place; `drainStaleRuns` reuses it for the concurrency wave. (Caught a bug: `chunkByParams`'s 2nd arg is _columns-per-row_, not chunk size — reusing it directly would have made waves of `floor(99/N)`.) |
| `drainStaleRuns` + `sweepStaleRuns` + `SweepStaleRunsResult`          | `src/lib/ingest.ts`                                             | The budget policy seam. `STALE_RUN_FINALIZE_CONCURRENCY = 10` bounds in-flight finalizations; `.limit` bounds the total per invocation.                                                                                                      |
| Cron reduced to a thin adapter calling `sweepStaleRuns`               | `crons/sweep-stuck-runs.ts`                                     | Removed the inline `db.select`/serial loop/try-catch; log now includes `failed`.                                                                                                                                                             |
| `WRIGHTFUL_SWEEP_BATCH_SIZE` (default 200)                            | `env.ts`                                                        | The per-invocation drain cap.                                                                                                                                                                                                                |
| `runs_status_lastActivityAt_idx` on `(status, lastActivityAt)`        | `db/schema.ts` + migration `20260530181157_fancy_screwball.sql` | The sweep SELECT was a status-filtered table scan (all existing `runs` indexes are `projectId`-first). Index lets D1 seek straight to `running` rows. Additive migration generated via `void db generate`, applied on deploy.                |

## Tests

- New `src/__tests__/drain-stale-runs.test.ts` (6 cases) pins the pure
  orchestrator against a fake finalizer: full drain + tally, empty batch,
  **bounded concurrency** (`maxInFlight <= chunkSize`), **partial-failure
  tolerance** (one rejecting run never aborts the pass), per-failure `onError`
  reporting with the offending run, and optional `onError`.
- `src/__tests__/chunk-insert-rows.test.ts` extended with a `chunkBySize` block
  (consecutive chunks, empty array, size ≥ length, non-positive size ⇒ one item
  at a time / no infinite loop).

`sweepStaleRuns` itself (the D1 SELECT) is not unit-testable — the dashboard
vitest harness stubs `void/db` to throw on access — so it stays a thin adapter
over the tested `drainStaleRuns`. Integration gap noted.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (codegen + tsgo, 0 errors).
- `vp test run` (full dashboard suite) — 522 passed / 43 files.
- `vp fmt --write` on changed files — clean.
- Migration journal + snapshot regenerated consistently (`runs` now has 6
  indexes; `20260530180525_naive_proudstar` [F80 `lastActivityAt` column]
  precedes the new index migration).
