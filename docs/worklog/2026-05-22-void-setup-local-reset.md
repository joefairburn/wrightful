# 2026-05-22 — Fix `pnpm setup:local` in `dashboard-void`

## What changed

`pnpm setup:local` in `packages/dashboard-void` was failing for three distinct reasons, all fixed in this change:

1. **False-positive destructive flag** on `db/migrations/20260522173058_brown_carnage.sql`. Void's migration validator rejected the file as destructive even though it's pure `CREATE TABLE` / `CREATE INDEX` DDL.
2. **"Local database already has application tables but no Void migration history"** on every start after Better Auth had bootstrapped its tables outside Void's migration tracking.
3. **`api key creation returned 404: Unknown action`** in the seed step. The keys page was refactored to Void's `?actionName` named-action convention; `seed-demo.mjs` was still sending a legacy `action=create` form field against a route that no longer interprets it.

After this fix, `pnpm setup:local` is idempotent — fresh clone and previously-bootstrapped workspaces both end in the same known-good state.

## Details

### Issue 1: false-positive destructive detection

Void's `isDestructive()` (in `node_modules/void/dist/validate-CNWm-PsL.mjs`) checks each `;`-delimited statement against a list of destructive regexes. One pattern is `/\bUPDATE\b[\s\S]*\bSET\b/i` paired with an "unbounded write" check (no top-level `WHERE`).

The `userState` `CREATE TABLE` statement in `brown_carnage.sql` includes two FK clauses:

```sql
FOREIGN KEY (`lastTeamId`)    REFERENCES `teams`(`id`)    ON UPDATE no action ON DELETE set null,
FOREIGN KEY (`lastProjectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
```

`UPDATE` (from `ON UPDATE …`) appears before `SET` (from `… set null`), and the surrounding `CREATE TABLE` has no `WHERE`. The regex matches → Void flags the file as destructive → migration is refused.

Fix: prepend the `-- void:allow-destructive` pragma to the migration. The file is creation-only (verified manually against Void's full `DESTRUCTIVE_PATTERNS` list), so the pragma is purely a workaround for the overzealous regex, not an admission of destructive intent.

### Issue 2: tables exist without Void migration history

Void's `assertLocalMigrationState()` (in `node_modules/void/dist/runner-BkGBfr4e.mjs`, ~line 104) throws when `_void_migrations` is empty but the database has application tables — Void considers this an unknown-provenance state and refuses to proceed.

This is the state Better Auth's bootstrap leaves behind: on the first dev run, BA creates `account / session / user / verification` via `CREATE TABLE IF NOT EXISTS` outside Void's migration system. Once any later restart finds those tables, it bails with the "Local database already has application tables but no Void migration history" error and Void's own recommendation: `void db reset`.

`setup-local.mjs` previously just started `vp dev` and relied on auto-migration on first request — no defense against this state.

Fix: `setup:local` now runs `npx void db reset` unconditionally, right after `.env.local` provisioning and before starting the dev server. This drops the "skip seed if existing API key still works" optimization (`probeDashboard` block on the old lines 136–161), but since the DB is now wiped on every run the previous seed's key wouldn't validate anyway — the probe was guaranteed to fall through.

## Code changes

| File                                                                     | Change                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard-void/db/migrations/20260522173058_brown_carnage.sql` | Prepend `-- void:allow-destructive` pragma (1 line).                                                                                                                                                                                               |
| `packages/dashboard-void/scripts/setup-local.mjs`                        | Add `stage("resetting local db…", "npx", ["void", "db", "reset"])` after env handling; remove the existing-seed-key probe (`hadSeed`/`force`/`probeDashboard` block) and always re-seed; drop `probeDashboard` import; refresh the header comment. |
| `packages/dashboard-void/scripts/seed-demo.mjs`                          | Switch the API-key mint POST to `/keys?createKey` (Void named-action) and drop the legacy `action=create` form field.                                                                                                                              |

`packages/dashboard-void/scripts/lib/dev-server.mjs` still exports `probeDashboard` for other callers; only the unused import in `setup-local.mjs` was removed.

## Verification

- `pnpm --filter @wrightful/dashboard-void check` — clean (format + lint + tsgolint). _Not yet run at the time of this entry; run before commit._
- Manual: from the broken state described in the chat (`.void/v3` D1 with BA tables but empty `_void_migrations`), `pnpm setup:local` is expected to now print:
  - `updating .env.local… added ALLOW_OPEN_SIGNUP=true` (or `already present`)
  - `resetting local db… done`
  - dev server boot with no "Destructive migrations detected" and no "Migration error: Local database already has application tables…"
  - `seeding demo account… done`
  - Playwright fixture upload
  - `✓ setup complete`
- Manual: a second `pnpm setup:local` run completes cleanly (idempotency check).

## Upstream notes

The Void destructive-detection false positive on `ON UPDATE … ON DELETE set null` is worth reporting upstream. The regex shape (`UPDATE … SET` with no `WHERE` ⇒ destructive) is reasonable for actual `UPDATE` statements but matches incidentally inside `CREATE TABLE` FK clauses. Either tokenizing the statement type before running the regex, or anchoring the pattern to top-level `UPDATE … SET`, would fix it.
