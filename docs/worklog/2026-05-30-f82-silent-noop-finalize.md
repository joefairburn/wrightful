# 2026-05-30 — F82: silent no-op finalize in the watchdog tail

## What changed

`finalizeStaleRun` (the watchdog's per-run finalizer) and `completeRun` share the
`reconcileAndBroadcast` tail: run the caller's status-flip UPDATE + a single
`aggregateRecomputeStatement` in one `db.batch`, then broadcast the recompute's
`.returning()` summary to `run:<runId>` subscribers.

`finalizeStaleRun`'s flip is guarded on `status='running'`, so when a finalize
**no-ops** — an overlapping cron pass, or a real `/complete` that won the race
left the run already off `'running'` — the guarded UPDATE matches 0 rows. But the
recompute is keyed only on `(projectId, runId)`, so it still matched the row and
its `.returning()` still produced a summary; the old `if (summary)` guard
therefore still fired a redundant `void/live` `progress` event (and spent a second
round-trip on it).

This makes a no-op finalize **fully silent**:

- New pure helper `statementChangedRows(batchResult)` in `src/lib/ingest.ts` reads
  a non-`.returning()` statement's affected-row count from its `db.batch` result
  element (`meta.changes`; Drizzle passes a `run`-method statement's raw D1Result
  straight through). It's the head-of-batch counterpart to `summaryFromBatchResults`
  (the tail-row reader) — the single typed home for "did the guarded flip change a
  row?", with a missing-count fallback of 0 (the conservative "nothing changed").
- `reconcileAndBroadcast` now runs the batch directly (instead of via
  `runBatchWithSummary`) so it can read BOTH ends — `statementChangedRows(batchResults[0])`
  for the flip and `summaryFromBatchResults` for the summary. A new optional
  `{ requireStatusFlip }` gates the broadcast: when set and the flip changed 0
  rows, it returns the (still-correct) summary early and skips the broadcast.
- `finalizeStaleRun` opts in with `requireStatusFlip: true`. `completeRun`'s merge
  UPDATE has no status guard (it always matches the owned row), so it leaves the
  flag off and always broadcasts — behaviour unchanged.

## Scope note

Per the verifier's correction, this is a **low-severity efficiency nit, not a
correctness/race fix**. The original finding claimed a racing finalize could
broadcast a contradicting `'interrupted'` terminal and clobber a completed run's
terminal in viewers' eyes — that is FALSE. The broadcast summary is read back from
the row (`AGGREGATE_SUMMARY_COLUMNS.status = runs.status`) after the guarded UPDATE
in the same atomic batch, so on a race the recompute reads the already-committed
terminal (`'passed'`/`'failed'`) and the broadcast carries the CORRECT status. The
DB status itself was already protected by the guarded UPDATE. The only real
residual was the wasted second round-trip + a duplicate-but-consistent live event;
those are what this suppresses. No comments justify it as preventing a
contradiction.

## Details

| Change                                                                          | File                | Why                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `statementChangedRows(batchResult)`                                             | `src/lib/ingest.ts` | One typed home for the head-of-batch `meta.changes` read; pairs with `summaryFromBatchResults`.                                                 |
| `reconcileAndBroadcast` runs `runBatch` directly + `{ requireStatusFlip }` gate | `src/lib/ingest.ts` | Inspect the flip's affected-row count (not just the tail summary) to suppress a no-op finalize's broadcast in the one shared tail.              |
| `finalizeStaleRun` passes `requireStatusFlip: true`                             | `src/lib/ingest.ts` | Opt the guarded-flip path into silent no-ops; `completeRun` stays opt-out.                                                                      |
| `runBatchWithSummary` docstring narrowed                                        | `src/lib/ingest.ts` | It is now the `appendRunResults` summary-only helper; the terminal paths go through `reconcileAndBroadcast`, which also reads the head element. |

## Tests

- `src/__tests__/summary-from-batch.test.ts` — new `statementChangedRows` block (5
  cases): reads `meta.changes` on a matched flip, returns 0 on a 0-change no-op,
  and defaults to 0 for shapes without a numeric `meta.changes` (rows array,
  `undefined`, `{}`, `{ meta: {} }`, non-numeric count).
- `src/__tests__/reconcile-and-broadcast.test.ts` — new `requireStatusFlip` block
  (3 cases): suppresses the broadcast (but still returns the summary) on a 0-row
  flip, broadcasts on a real flip, and still broadcasts on a 0-row head when the
  flag is OFF (the `completeRun` path).

`finalizeStaleRun` end-to-end (the real D1 batch) stays an integration gap — the
dashboard vitest harness stubs `void/db` to throw on access — so only the pure
read + the orchestration gate are unit-tested.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (codegen + tsgo, 0 errors).
- `vp test run` (full dashboard suite) — 528 passed / 43 files (was 522; +6 new cases).
