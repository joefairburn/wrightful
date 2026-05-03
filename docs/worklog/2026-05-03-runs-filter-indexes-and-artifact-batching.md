# 2026-05-03 — Runs-list filter indexes, artifact batch insert, user-state bundle reuse

## What changed

Three small cleanups picked off from the `2026-05-03` DB/DO architecture review:

1. **`runs` table — three composite indexes leading with `projectId`** for the runs-list filter dropdowns.
2. **`POST /api/artifacts/register` — chunks now go through `scope.batch`** instead of a sequential `await … .execute()` loop.
3. **`POST /api/user-state/last-team` and `…/last-project`** now use `resolveTenantBundleForUser` instead of the bespoke `resolveTeamBySlug` / `resolveProjectBySlugs` helpers.

## Details

### Filter-dropdown indexes

`FilterBarLoader` in `packages/dashboard/src/app/pages/runs-list.tsx:174-199` runs three parallel queries to populate the filter dropdowns:

```sql
SELECT DISTINCT branch       FROM runs WHERE projectId = ? AND committed = 1 AND branch       IS NOT NULL;
SELECT DISTINCT actor        FROM runs WHERE projectId = ? AND committed = 1 AND actor        IS NOT NULL;
SELECT DISTINCT environment  FROM runs WHERE projectId = ? AND committed = 1 AND environment IS NOT NULL;
```

Existing indexes on `runs`:

| Index                                       | Columns                     |
| ------------------------------------------- | --------------------------- |
| `runs_project_idempotency_key_idx` (unique) | `projectId, idempotencyKey` |
| `runs_ci_build_id_idx`                      | `ciBuildId`                 |
| `runs_branch_created_at_idx`                | `branch, createdAt`         |
| `runs_environment_created_at_idx`           | `environment, createdAt`    |
| `runs_project_created_at_idx`               | `projectId, createdAt`      |

None of these are usable as a covering scan for `WHERE projectId = ? GROUP BY <col>`. `runs_branch_created_at_idx` and `runs_environment_created_at_idx` lead with the wrong column for any project-scoped query and are essentially unused (every read path is project-scoped). Flagged for follow-up cleanup but left in place for this change.

Three new composite indexes added as a stacked migration `0001_runs_filter_indexes` in `packages/dashboard/src/tenant/migrations.ts`. We're post-launch — `0000_init` is frozen, schema changes go in additive numbered migrations that run on every existing tenant DO on next request without rewriting tables.

- `runs_project_branch_idx` on `(projectId, branch)`
- `runs_project_actor_idx` on `(projectId, actor)`
- `runs_project_environment_idx` on `(projectId, environment)`

These are covering indexes for the three dropdown queries — SQLite skip-scans distinct values without touching the row data. `CREATE INDEX` on a populated table is a one-time index build (proportional to row count); subsequent reads use the index. No data is rewritten.

The stale "pre-launch: edit `0000_init` in place" comments at the top of `tenant/migrations.ts` and `control/migrations.ts` were also updated to document the post-launch stacking policy.

### Artifact registration: batch instead of sequential loop

`registerHandler` in `packages/dashboard/src/routes/api/artifacts.ts:153-158` was inserting artifact rows in a `for` loop with one awaited `db.insertInto().execute()` per chunk. This had two problems:

1. **N DO RPCs per call.** A reporter batch with many artifacts (screenshots, traces, videos across a 50-test shard) hits the TenantDO once per `ARTIFACT_ROWS_PER_STATEMENT`-sized chunk — pure round-trip cost.
2. **Not atomic.** A failure mid-loop left a partial set of rows; the response would already have handed back R2 PUT URLs whose corresponding rows were never written.

Now collects `Compilable[]` and sends a single `scope.batch(statements)` — same pattern as `appendResultsHandler` at `packages/dashboard/src/routes/api/runs.ts:482-483`. One DO RPC, all-or-nothing via `transactionSync` inside the DO.

### user-state bundle reuse

`packages/dashboard/src/routes/api/user-state.ts` was the last caller of `resolveTeamBySlug` outside of legacy paths and the last app-route caller of `resolveProjectBySlugs` outside of settings/auth bootstrap. RPC count is unchanged (1 verify + 1 update either way), but consolidating onto `resolveTenantBundleForUser` removes two more import sites for resolvers we'd like to eventually delete.

## Code fixes / migrations

| File                                                 | Change                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard/src/tenant/migrations.ts`        | Added stacked `0001_runs_filter_indexes` migration with 3 composite `(projectId, …)` indexes; updated the migration-policy comment from pre-launch to post-launch.                   |
| `packages/dashboard/src/control/migrations.ts`       | Updated the (mirror) migration-policy comment to post-launch stacking.                                                                                                               |
| `packages/dashboard/src/routes/api/artifacts.ts`     | Imported `Compilable`; replaced per-chunk `await` loop with `scope.batch(statements)`.                                                                                               |
| `packages/dashboard/src/routes/api/user-state.ts`    | Switched both handlers to `resolveTenantBundleForUser`; reads `bundle.activeTeam` / `bundle.activeProject`.                                                                          |
| `packages/dashboard/src/__tests__/artifacts.test.ts` | Updated mock `scope.batch` to capture `batchCalls` (mirroring `runs.test.ts`); the success-path assertion now compiles batched queries instead of inspecting `tenantDriver.queries`. |

## Verification

- `pnpm typecheck` — clean.
- `pnpm lint` — 31 warnings, 0 errors (unchanged from baseline; none in the touched files).
- `pnpm test` — `dashboard` 167/167, `reporter` 81/81.
- Index verification: on next request to a tenant DO, rwsdk's `InMemoryMigrationProvider` will see `0001_runs_filter_indexes` is unapplied and run it inside the DO's `blockConcurrencyWhile(initialize)`. `CREATE INDEX` on a populated `runs` table is proportional to row count; for typical project sizes this is sub-second. `EXPLAIN QUERY PLAN` after deploy should show `SCAN INDEX runs_project_branch_idx` (covering) for the dropdown queries instead of `SCAN runs`.
