# 2026-05-30 — ingest internals: pure seams behind the D1 batch pipeline

## What changed

The streaming-ingest pipeline (`src/lib/ingest.ts`) carried several conventions
that were re-transcribed by hand at multiple call sites — each transcription an
un-tested place the convention could silently drift. This cluster concentrated
those into small, unit-tested seams without changing runtime behaviour.

- **Param-chunk column counts (F02 / F16).** Five hand-counted column-count
  literals fed the `<=99`-param chunker: `TEST_RESULTS_COLUMNS=14`,
  `TEST_TAGS_COLUMNS=4`, `TEST_ANNOTATIONS_COLUMNS=5`,
  `TEST_RESULT_ATTEMPTS_COLUMNS=9` in `ingest.ts` and `ARTIFACT_COLUMNS=12` in
  `routes/api/artifacts/register.ts`. A new nullable column makes `$inferInsert`
  optional, so it lands in the row literal with no compile error while the stale
  literal count overflows the chunk and D1 rejects the statement at runtime.
  Added `chunkInsertRows(rows)` — derives `columnsPerRow` from
  `Object.keys(rows[0]).length` (the SAME object handed to `.values()`), so the
  count can't drift. All five callers now go through it; the literals are gone.
  (F16 was fully subsumed by F02 — same five constants — so no separate change.)

- **Status-merge invariant, JS ⇄ SQL (F01).** The monotonic shard-status-merge
  rule was transcribed twice: once in `mergeRunStatus` (JS reference) and once in
  the SQL `CASE` that `completeRun` actually executes. The severity table and the
  unknown-status fallback were written out in both. Extracted
  `runStatusSeverity(status)` + `UNKNOWN_STATUS_SEVERITY` as the single owner of
  the rank lookup, and `currentStatusSeveritySql()` / `mergeRunStatusSql()` that
  build the SQL `CASE` from that same table. Both encodings now derive rank and
  fallback from one place; a new test reconstructs the SQL from the `void/db`
  stub's `sql` capture and binds it to the JS reference, so editing one
  encoding's rank/tie-break/running-case without the other now fails.

- **"Summary is the last batch row" (F05).** All three write paths appended a
  summary-producing statement last, ran the batch, then read
  `batchResults[len-1] as RunAggregateSummary[] | undefined ?.[0]` by hand.
  Extracted `summaryFromBatchResults(batchResults)` (pure positional read,
  normalizes a no-row final statement to `null` not `undefined`) and
  `runBatchWithSummary(writes, summary)` (append-last → batch → extract). Callers
  no longer count array positions.

- **Typed `db.batch` wrapper (F18).** Drizzle types `db.batch` as a heterogeneous
  tuple of query builders that a dynamically-assembled `PromiseLike<unknown>[]`
  can't satisfy, so every batch call site reached for an `as never` cast — copied
  across 6 files. Added `runBatch(statements)` (`src/lib/db-batch.ts`) as the
  single owner of that one call-signature cast; callers pass a plain array and
  never cast. Converted all dynamic batch call sites:
  `ingest.ts` (both `openRun` paths via `runBatch`; `runBatchWithSummary` routes
  through it), the team/project deletes, the two invite accepts, and — completing
  the seam during gate review — the artifact-register insert in `register.ts`.

- **Terminal reconcile-and-broadcast tail (F70).** `completeRun` and
  `finalizeStaleRun` (the cron sweep) mirrored the same tail by copy: build the
  recompute statement, run it last with the caller's status-flip in one batch,
  read back the summary, broadcast iff a row matched. Extracted
  `reconcileAndBroadcast(runId, statusUpdate, recomputeScope)`; the two terminal
  paths now differ ONLY in the status-flip statement they pass. `bumpTeamActivity`
  is deliberately left at the callers (completeRun bumps, the cron sweep does not).

## Details

| Seam                                             | Home                  | Owns                                                                   |
| ------------------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `chunkInsertRows(rows)`                          | `src/lib/ingest.ts`   | per-row column count derived from the row shape; `<=99`-param chunking |
| `runStatusSeverity` / `UNKNOWN_STATUS_SEVERITY`  | `src/lib/ingest.ts`   | the single shard-status rank lookup + unknown fallback                 |
| `currentStatusSeveritySql` / `mergeRunStatusSql` | `src/lib/ingest.ts`   | the SQL `CASE` twin of `mergeRunStatus`, built from the same table     |
| `summaryFromBatchResults`                        | `src/lib/ingest.ts`   | the "last batch row is the summary" positional read                    |
| `runBatchWithSummary`                            | `src/lib/ingest.ts`   | append-summary-last → batch → extract                                  |
| `reconcileAndBroadcast`                          | `src/lib/ingest.ts`   | terminal recompute + summary broadcast tail                            |
| `runBatch`                                       | `src/lib/db-batch.ts` | the single `db.batch` call-signature `as never` cast                   |

### Behaviour notes

- `chunkInsertRows` reproduces the previous chunk sizes exactly for the real
  insert shapes (testResults 14 cols → 7/chunk, artifacts 12 → 8/chunk, etc.);
  it is `chunkByParams(rows, Object.keys(rows[0]).length)`. `chunkByParams`
  stays as the lower-level form the chunking-math test asserts against.
- `runBatch` is type-ergonomics only — it forwards the caller's array to
  `db.batch` unchanged (the cast is internal, runtime payload untouched) and
  returns the result array verbatim. D1's all-or-nothing atomicity (durable
  decision #10) still lives at the call sites that assemble the batch.
- The per-element `as never` casts inside `buildResultInsertStatements` come from
  the array ELEMENT type, not the `db.batch` call signature, so `runBatch` does
  not remove them (stated honestly in its docstring).

## Files

- `apps/dashboard/src/lib/ingest.ts` — `chunkInsertRows`, `runStatusSeverity` /
  `UNKNOWN_STATUS_SEVERITY`, `currentStatusSeveritySql` / `mergeRunStatusSql`,
  `summaryFromBatchResults` / `runBatchWithSummary`, `reconcileAndBroadcast`;
  `completeRun` / `finalizeStaleRun` / `appendRunResults` rewired onto them.
- `apps/dashboard/src/lib/db-batch.ts` — new; `runBatch`.
- `apps/dashboard/routes/api/artifacts/register.ts` — dropped `ARTIFACT_COLUMNS`,
  uses `chunkInsertRows`; converted the insert batch to `runBatch`.
- `apps/dashboard/crons/sweep-stuck-runs.ts` — `finalizeStaleRun` now shares the
  `reconcileAndBroadcast` tail; docstring updated.
- `apps/dashboard/pages/settings/teams/new.server.ts`,
  `.../[teamSlug]/general.server.ts`,
  `.../[teamSlug]/p/[projectSlug]/keys.server.ts`,
  `apps/dashboard/pages/invite/[token]/index.server.ts`,
  `apps/dashboard/routes/api/invites/[inviteId]/accept.ts` — `db.batch(... as never)`
  → `runBatch(...)`.
- `apps/dashboard/src/__tests__/chunk-insert-rows.test.ts` — new; anchors chunking
  to the real `$inferInsert` widths so a new column can't overflow a chunk.
- `apps/dashboard/src/__tests__/merge-run-status.test.ts` — added the SQL-encoding
  suite binding `mergeRunStatusSql` to the JS reference.
- `apps/dashboard/src/__tests__/summary-from-batch.test.ts` — new; positional read
  - null-normalization.
- `apps/dashboard/src/__tests__/db-batch.test.ts` — new; `runBatch` forwards
  unchanged + returns verbatim.
- `apps/dashboard/src/__tests__/reconcile-and-broadcast.test.ts` — new; status-flip
  FIRST / recompute LAST, broadcast-iff-matched, returns merged summary.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — 0 errors.
- `pnpm --filter @wrightful/dashboard test` — 160/160 pass (was ~113 baseline;
  the new files add 30 assertions across 5 cluster files plus prior clusters).
- `pnpm --filter @wrightful/reporter test` — 150/150 pass (not touched).
- `pnpm check` — 0 errors, 71 warnings (under the ~83 baseline). The one
  `no-unsafe-type-assertion` warning that remains on `db-batch.ts:37` is the
  single `as never` cast the seam was built to confine — what used to be the same
  warning scattered across 6 files now lives in one place.
- Integration gap (no real-D1 harness): the `db.batch` round-trip in
  `runBatchWithSummary` / `reconcileAndBroadcast` and the live UPDATE that
  executes `mergeRunStatusSql` are exercised end-to-end only by e2e, not unit
  tests. The pure halves (positional summary read, orchestration order, the
  JS⇄SQL severity-table binding, the chunking math) carry the footguns and are
  unit-tested here.
