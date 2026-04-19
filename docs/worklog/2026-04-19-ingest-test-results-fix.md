# 2026-04-19 — Fix half-written ingest: D1 param limit + two-phase commit for large suites

## What changed

`POST /api/ingest` was writing the `runs` row successfully but failing to write any `test_results`, leaving the DB in a half-state where the runs list rendered aggregate badges (e.g. `5 passed, 1 failed`) but the popover and run-detail page correctly reported "no results" — because the rows literally weren't there.

Two compounding causes:

1. **D1's 100-bound-parameter-per-query cap.** Ingest batched test_results inserts as a single multi-row `.values([...])` of up to 900 rows. With 13 columns per row, the fixture scenarios (8 tests each) produced 104 parameters — just over D1's limit. The insert threw `_DrizzleQueryError`, visible in the dev-server terminal.
2. **No atomicity across the inserts.** The `runs` row was inserted in its own `await`, then test_results/tags/annotations in subsequent awaits. When step 2 threw, the runs row stayed behind. The project-scoped idempotency guard then short-circuited any retry with `duplicate: true`, stranding the DB permanently in the half-written state.

The fix is in two layers in `packages/dashboard/src/routes/api/ingest.ts`:

- **Multi-row inserts chunked by param budget.** Each statement stays ≤99 bound params (7 test_results rows/stmt, 33 tags/stmt, 24 annotations/stmt) — can never hit D1's per-query cap.
- **Two-phase commit on a new `runs.committed` column.** The first batch inserts `runs` with `committed = false` and the first slice of children; subsequent batches stream the remaining children; the final batch flips `committed = true`. All reads filter `committed = true`, so any mid-ingest failure leaves the partial run invisible to users. A retry detects the uncommitted row by idempotencyKey and cascade-deletes it before re-inserting. This removes the previous fix's 1000-statement hard ceiling — arbitrarily large suites now work, even if they require multiple D1 batches, because atomicity is provided by the flag rather than by a single batch.

## Details

| File                                                    | Change                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard/src/db/schema.ts`                   | Added `committed: boolean (default false, not null)` to `runs`.                                                                                                                                                                                                                                                                                                    |
| `packages/dashboard/drizzle/0000_amused_spitfire.sql`   | Added `committed integer DEFAULT false NOT NULL` column to the initial migration (pre-launch squash policy — no stacked migration).                                                                                                                                                                                                                                |
| `packages/dashboard/src/routes/api/ingest.ts`           | Build a `BatchItem<"sqlite">[]` of multi-row inserts chunked against D1's param cap, then split into `MAX_STATEMENTS_PER_BATCH=1000` chunks. First batch inserts `runs(committed=false)`; final batch pushes `UPDATE runs SET committed=true`. Idempotency guard now distinguishes `committed=1` (return duplicate) from `committed=0` (cascade-delete and retry). |
| `packages/dashboard/src/routes/api/run-test-preview.ts` | Filter by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                                    |
| `packages/dashboard/src/routes/api/artifacts.ts`        | Filter run ownership query by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                |
| `packages/dashboard/src/routes/api/artifact-upload.ts`  | Filter join by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                               |
| `packages/dashboard/src/app/pages/runs-list.tsx`        | Filter by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                                    |
| `packages/dashboard/src/app/pages/run-detail.tsx`       | Filter by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                                    |
| `packages/dashboard/src/app/pages/test-detail.tsx`      | Filter ownership join by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                     |
| `packages/dashboard/src/app/pages/test-history.tsx`     | Filter join by `runs.committed = 1`.                                                                                                                                                                                                                                                                                                                               |

No dependency changes. FK cascades already in place handle retry cleanup: `runs → test_results → test_tags/test_annotations/artifacts`.

## Follow-up hardening (same session)

- **`committed_runs` view.** Added `committedRuns` as a drizzle `sqliteView` (in schema + migration) that selects rows where `committed = 1`. Every read path now imports `committedRuns` instead of `runs`; writes + the idempotency check in ingest still use `runs` directly so they can see uncommitted rows. Makes it impossible to accidentally surface an in-flight ingest from a new query. Required splitting the test-detail join into two parallel queries because drizzle's inference chokes on mixed view+table `.select({...})` shapes.
- **Local-D1 schema drift detection in `setup:local`.** Probes `pragma_table_info('runs')` for the `committed` canary column. If the table exists without it (classic pre-launch squashed-migration symptom), wipes `.wrangler/state/v3/d1` + `.dev.vars.seed.json` and falls through to a clean re-apply. Idempotent on an up-to-date DB. Verified both paths.
- CLI exit behaviour (#2 from the post-hoc review) was already correct: `ApiClient.ingest` throws on `!response.ok` (api-client.ts:96) and `upload.ts:124` exits code 1. No change needed.

## Verification

- Blew away local D1, re-ran `pnpm --filter @wrightful/dashboard db:migrate:local` + `db:seed-demo`, re-ran `pnpm --filter @wrightful/dashboard fixtures:generate`.
- Fresh fixtures: 3 runs, each with `committed=1` and `total_tests == test_results row count`. Dev server terminal clean.
- Retry-after-failure probe:
  1. Manually inserted a stub run with `committed=0` and `idempotency_key='retry-probe-key'`.
  2. Confirmed `SELECT COUNT(*) FROM runs WHERE committed=1` excluded it (invisible to every UI read path).
  3. POSTed an ingest with the same idempotencyKey → handler detected the uncommitted row, cascade-deleted it, inserted a fresh run, and returned 201 with a new `runId`. Final DB state: the stub is gone and only the new committed row exists for that key.
  4. POSTed the same ingest a second time → returned `duplicate: true` as expected.
- `pnpm typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 55 passed.
- `pnpm lint` — 4 pre-existing warnings, 0 errors.

Popover + run-detail pages were not modified for data reasons; they were correct from the start. The `committed` filter was added for visibility-of-in-flight-runs reasons only.
