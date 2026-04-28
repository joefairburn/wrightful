# 2026-04-27 — Control-D1 migrations move into the worker

## What changed

Replaced the wrangler-CLI migration path with an in-worker migration runner, plus moved the deploy flow to **staged versions** so a failed migration leaves the previous version serving traffic. The deploy flow is now:

1. `wrangler versions upload` — uploads the new Worker version _without promoting it_. Previous version keeps serving 100% of traffic. Auto-provisions D1/R2/DOs on first run.
2. POST `/api/admin/migrate` against the **new version's preview URL** with `MIGRATE_SECRET`. The new code's migration list runs against D1 via Kysely's `Migrator`.
3. `wrangler versions deploy <id>@100%` — promotes the uploaded version, but only if step 2 succeeded.

If migration fails, the new version sits dormant; the old version keeps serving. Orchestrated by `packages/dashboard/scripts/staged-deploy.mjs`, which uses Wrangler 4's `WRANGLER_OUTPUT_FILE_PATH` ND-JSON to deterministically parse the version id + preview URL from the upload step.

This sidesteps the auto-provisioning gap in `wrangler d1 migrations apply` (cloudflare/workers-sdk#13632) entirely — we no longer talk to D1 from the build environment. The endpoint-and-Kysely-Migrator pattern matches what tenant DOs already do (`packages/dashboard/src/tenant/migrations.ts` + `tenant-do.ts`): in-memory migrations object, `Kysely.Migrator`, `__migrations` + `__migrations_lock` tracking tables. Tenant DOs trigger lazy on first query; the control D1 triggers via the explicit endpoint to avoid migration-on-every-isolate-cold-start.

## Details

| Change                                                        | File(s)                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| Embed `0000_init.sql` as a Kysely migration via Vite's `?raw` | `packages/dashboard/src/db/migrations.ts` (new)            |
| `migrateControlDb()` runner                                   | `packages/dashboard/src/db/migrate.ts` (new)               |
| `POST /api/admin/migrate` handler with bearer auth            | `packages/dashboard/src/routes/admin/migrate.ts` (new)     |
| Mount route ahead of the `/api` bearer prefix                 | `packages/dashboard/src/worker.tsx`                        |
| Staged deploy orchestrator (upload → migrate → promote)       | `packages/dashboard/scripts/staged-deploy.mjs` (new)       |
| Migrate-only fetch helper (used locally / for retries)        | `packages/dashboard/scripts/post-deploy-migrate.mjs` (new) |
| `MIGRATE_SECRET` typed on `Cloudflare.Env`                    | `packages/dashboard/types/env.d.ts`                        |
| `MIGRATE_SECRET` placeholder in `.dev.vars`                   | `packages/dashboard/.dev.vars.example`, `setup-local.mjs`  |
| `0000_init.sql` made idempotent (`CREATE … IF NOT EXISTS`)    | `packages/dashboard/migrations/0000_init.sql`              |
| `*?raw` ambient module declaration                            | `packages/dashboard/types/vite.d.ts`                       |
| Removed wrangler-side `db:migrate:remote` npm script          | `packages/dashboard/package.json`                          |
| `deploy` / `deploy:remote` use staged orchestrator            | `packages/dashboard/package.json`, root `package.json`     |
| Updated `wrangler.jsonc` comment to point at the new flow     | `packages/dashboard/wrangler.jsonc`                        |
| Self-hosting docs: new env var + recovery procedure           | `SELF-HOSTING.md`                                          |

## Why split-statement execution

D1 doesn't accept multi-statement SQL through its public API (Kysely's `sql.raw().execute()` goes through prepare/run, single statement only). The migration files already use `--> statement-breakpoint` markers between top-level statements (a Drizzle-kit-style convention preserved through earlier history); `migrations.ts` splits on those and executes each statement individually. Keeps the `.sql` files unchanged and dual-purpose: `wrangler d1 migrations apply DB --local` still reads them for local dev.

## Why explicit endpoint over lazy auto-migrate

Considered putting `await migrateControlDb()` in a request middleware (mirroring tenant DOs' `await this.initialize()` pattern). For tenant DOs it's free after the first call thanks to in-memory `initialized`. For the worker, isolate cold starts are frequent, and Kysely's Migrator does ~3 D1 round trips per call even when nothing's pending (lock acquire / read applied / lock release). That's ~60–120ms added to the first request per cold isolate.

The endpoint pattern keeps the runtime free at the cost of a single CI fetch per deploy. For a low-traffic test-reporting dashboard the runtime cost would have been small but real; the user's call was to push the cost onto CI, not requests.

## Local dev

`db:migrate:local` keeps using `wrangler d1 migrations apply DB --local` against the SQLite file under `.wrangler/state/v3/d1`. Same `.sql` files, no auto-provisioning gap locally — wrangler CLI is fine here. The new `post-deploy-migrate.mjs` is remote-only.

## Failure handling and discipline

D1 has no transactions in its public API, so a migration that throws partway leaves partial schema. The staged-deploy pattern contains the _code_ damage (new version stays unpromoted on failure), but the half-applied schema persists. Mitigations baked in:

- **`0000_init.sql` uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`** so a retry after partial failure picks up cleanly.
- **Forward-only / additive migration discipline** — never drop or rename in the same migration as the code that stops using the column. The brief window between schema apply and version promote means old code may run against partially-migrated DB.
- **Lock-stuck recovery** documented in `SELF-HOSTING.md` ("Recovering from a failed migration"): manual `UPDATE __migrations_lock SET is_locked = 0` if the migrator crashed before releasing.
- **60-second fetch timeout** on the migrate POST in both `staged-deploy.mjs` and `post-deploy-migrate.mjs` — failure surfaces as a clear timeout in the build log instead of hanging until CF Builds' 90-minute build cap.

## Schema-only migrations only

This hook is sized for schema migrations: `CREATE TABLE`, `ALTER TABLE`, indexes, idempotent `INSERT`s for seed rows. Sub-second on D1, well within the Worker fetch handler's wall-clock budget.

**Don't put data-backfill migrations in this hook.** Worker fetch handlers have a ~30s wall-clock ceiling regardless of the `cpu_ms` config (CPU and wall-clock are different limits). A migration that backfills millions of rows will time out, leave the schema half-applied, and fail the deploy.

For data backfills: write them as one-off scripts in `packages/dashboard/scripts/`, run via `wrangler d1 execute --remote` from a developer machine after the schema migration ships. Same pattern Postgres/MySQL shops use — never tie a long-running data move to the deploy hook.

## Existing deployment migration

The currently-deployed worker (`wrightful-bumper`) had its schema applied via the old `wrangler d1 migrations apply` path. After this change is deployed, the first POST to `/api/admin/migrate` will see an empty `__migrations` table and try to apply `0000_init`. With the new `IF NOT EXISTS` clauses, the SQL itself is now idempotent — but Kysely will still execute the body and then write a `__migrations` row, so a clean re-run is safe.

If you'd rather skip the re-run entirely, pre-seed `__migrations` against the live D1 once before deploying:

```sql
CREATE TABLE IF NOT EXISTS __migrations (
  name TEXT NOT NULL PRIMARY KEY,
  timestamp TEXT NOT NULL
);
INSERT OR IGNORE INTO __migrations (name, timestamp)
VALUES ('0000_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

Run via:

```bash
pnpm --filter @wrightful/dashboard exec wrangler d1 execute DB --remote --command="…"
```

(Self-hosters who deploy fresh from this point onward don't need this — `__migrations` is created by Kysely's Migrator on first run before applying anything.)

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` passes — including the new `env.MIGRATE_SECRET` typing.
- `oxlint` clean on the new TS + the post-deploy script.
- Local dev path unchanged: `pnpm setup:local` still uses `wrangler d1 migrations apply DB --local`.
- End-to-end remote verification belongs on the next CF Builds deploy after the user pre-seeds `__migrations` and adds `MIGRATE_SECRET` (Worker secret + Build env var).
