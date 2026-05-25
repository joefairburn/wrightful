# 2026-05-23 — Void schema first-principles audit

`packages/dashboard-void` was ported 1:1 from the legacy
`packages/dashboard` (ControlDO + per-team TenantDOs). Some shape
choices carried over from that physical-isolation world that don't earn
their keep under D1 logical isolation. With the decision that
`dashboard-void` is the only dashboard going forward (no backwards
compatibility, no ETL from the old deployment), the schema can be
designed for what we actually need.

## What changed

### `runs` table (`packages/dashboard-void/db/schema.ts`)

| Change                                        | Old                              | New                                         | Why                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop `runs.committed`                         | `integer NOT NULL DEFAULT 0`     | gone                                        | Set to `1` on insert at `routes/api/runs/index.ts:107` and read nowhere. Dead column.                                                                                                                                                                                                                                                                                         |
| Drop `runs_ci_build_id_idx`                   | `INDEX (ciBuildId)`              | gone                                        | `ciBuildId` is rendered for display only; never appears in a WHERE clause. Dead index.                                                                                                                                                                                                                                                                                        |
| Re-prefix branch index                        | `INDEX (branch, createdAt)`      | `INDEX (projectId, branch, createdAt)`      | Every actual query is project-scoped first. The non-prefixed index is unusable for the planner under that predicate.                                                                                                                                                                                                                                                          |
| Re-prefix env index                           | `INDEX (environment, createdAt)` | `INDEX (projectId, environment, createdAt)` | Same reason.                                                                                                                                                                                                                                                                                                                                                                  |
| Drop redundant `runs_project_branch_idx`      | `INDEX (projectId, branch)`      | gone                                        | Subsumed by the new `(projectId, branch, createdAt)`.                                                                                                                                                                                                                                                                                                                         |
| Drop redundant `runs_project_environment_idx` | `INDEX (projectId, environment)` | gone                                        | Subsumed by the new `(projectId, environment, createdAt)`.                                                                                                                                                                                                                                                                                                                    |
| Rewrite `runs.teamId` doc-comment             | "for query speed"                | Defense-in-depth + live-socket authz        | The original justification was lifted from the legacy world where TenantDOs were physically per-team. The real reasons under logical isolation are: (1) the `AuthorizedProjectId` brand pairs with a `teamId` filter so a leaked project id can't cross teams; (2) `src/live.ts` does a single-hop `SELECT teamId FROM runs WHERE id = ?` to authorise websocket subscribers. |

Net: 26 → 25 columns, 7 → 5 indexes on `runs`.

### Code

- `packages/dashboard-void/routes/api/runs/index.ts` — removed
  `committed: 1` from the run insert payload.

### Migration

The legacy worklog entry confirmed nothing has been deployed yet
(`Build, production deploy, and live ingest haven't been exercised
yet`), and no local D1 state exists. Regenerated the single initial
migration in place rather than stacking a cleanup migration on top of
an unshipped one:

- Removed `db/migrations/20260522173058_brown_carnage.sql` + its meta
  snapshot.
- Reset `db/migrations/meta/_journal.json` to empty.
- Ran `pnpm exec void db generate` → emitted
  `db/migrations/20260523124136_dizzy_wong.sql` (13 tables, 28 indexes
  — down from 31, all four legacy-driven artefacts gone).

## Decisions that did NOT change (and why)

Worth recording so the next pass doesn't re-litigate:

- **`projectId` denormalised on every run-scoped child table**
  (`testResults`, `testTags`, `testAnnotations`, `testResultAttempts`,
  `artifacts`). Genuinely justified under logical isolation: the
  `AuthorizedProjectId` brand can enforce scope at the type level
  without runtime joins. Originally added in legacy
  `0003_add_project_id`, but the _reason_ it exists in void is
  different — keep.

- **Aggregate counters on `runs` (`passed`/`failed`/`flaky`/`skipped`/
  `durationMs`/`totalTests`)**. Maintained incrementally during
  streaming ingest. Trade-off is ingest-path complexity vs. runs-list
  rendering without a subquery per row. Keep.

- **Duplicated `errorMessage` / `errorStack` / `durationMs` between
  `testResults` and `testResultAttempts`**. `testResults` caches the
  _final_ attempt so list views render without joining the attempts
  table. Real duplication, real win; keep.

- **`userGithubAccounts` as a separate table**. Driven by Better
  Auth's ownership of `account` (we can't extend its schema), not by
  legacy carry-over. Not changeable.

- **`runs.teamId` denormalisation**. Originally lifted from the legacy
  "TenantDO is keyed by team" world, but earns its keep under D1 — see
  doc-comment rewrite above.

## Removed: `docs/etl/legacy-to-d1-mapping.md`

The schema audit + ETL plan for migrating production data from the
legacy ControlDO + TenantDOs into the new D1 was written assuming a
cutover migration. Since we're not migrating data, the doc is obsolete
and its "preserve `keyHash`/`r2Key`/session formats exactly" constraints
were holding the new schema to legacy shape unnecessarily. Removed.

## Verification

```bash
cd packages/dashboard-void
pnpm exec void prepare                              # ok
pnpm exec void db generate                          # emits 20260523124136_dizzy_wong.sql
pnpm exec tsc --noEmit                              # 0 errors
pnpm exec vp check                                  # 0 errors, 75 warnings (pre-existing no-unsafe-type-assertion)
pnpm exec vp fmt --check db/ routes/ src/           # all source dirs clean
```

Build (`vp build`), production deploy (`void deploy`), and end-to-end
ingest still haven't been exercised — same status as the migration
worklog. None of the changes here affect those paths beyond what the
new migration SQL declares.
