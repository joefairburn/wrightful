# 2026-04-19 — setup-local detects missing `committed_runs` view

## What changed

`packages/dashboard/scripts/setup-local.mjs` now probes for the `committed_runs`
view in addition to the existing `runs.committed` column canary, and wipes the
local D1 state when the view is missing.

## Why

Commit `7197030` added a `committed_runs` SQL view to the squashed initial
migration. Pre-launch we edit `0000_*.sql` in place instead of stacking a new
migration — so a local DB already tagged `0000_*` in `d1_migrations` will
never re-run the migration and will never pick up the new `CREATE VIEW`.

The symptom for one dev was a runtime failure in the runs-list query:

```
Failed query: select … "committed" from "committed_runs" where "committed_runs"."project_id" = ? …
```

`PRAGMA table_info(runs)` showed `runs.committed` already present, so the
existing column-based canary passed and the wipe didn't fire. The view was
genuinely missing (`sqlite_master` had `runs` but no `committed_runs`).

## Details

`setup-local.mjs`:

- Factored probe invocation into `runProbe(sql)` and wipe into
  `wipeLocalD1()`.
- After the existing `runs.committed` check passes, we now also run
  `SELECT name FROM sqlite_master WHERE type='view' AND name='committed_runs'`.
  If the JSON result doesn't contain `committed_runs`, wipe + re-migrate.
- Guarded so wiping only happens when the `runs` table exists — fresh devs
  with no `.wrangler` dir still skip the probe entirely via the outer
  `existsSync(d1StateDir)` guard.

## Verification

- Reproduced the drift: `sqlite_master` query returned an empty views list
  on the pre-change DB.
- Ran `pnpm --filter @wrightful/dashboard setup:local --no-fixtures`:
  printed `schema out of date… wiping local D1`, then `applying D1
migrations… done`.
- Re-queried `sqlite_master` — `committed_runs` view now present.
- No schema or migration files touched; the drift was purely in local state.
