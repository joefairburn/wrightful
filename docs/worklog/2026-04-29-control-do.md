# 2026-04-29 — Auth/tenancy moves from D1 to a singleton ControlDO

## What changed

Replaced the control D1 database with a singleton `ControlDO` (rwsdk's `SqliteDurableObject`) holding all auth/tenancy data — users, sessions, accounts, verifications, teams, projects, memberships, api_keys, invites, userOrganizations. Same pattern as the per-team `TenantDO` already uses; addressed by name `"control"`.

Deletes everything that existed to work around D1's auto-provisioning binding-resolution bug (cloudflare/workers-sdk#13632) and the fragility of routing migrations through preview URLs:

- `/api/admin/migrate` endpoint, `MIGRATE_SECRET` (Worker secret + Build env var), `staged-deploy.mjs`, `post-deploy-migrate.mjs`, `WORKERS_SUBDOMAIN` build env var.
- `workers_dev: true` and `preview_urls: true` in `wrangler.jsonc` (no longer load-bearing).
- The `d1_databases` block, the `DB` binding, the `migrations/` directory, `kysely-d1` dep, `src/db/`.
- The `db:migrate:local` script.

Net deploy command goes from a four-step staged orchestration to plain `wrangler deploy`. Self-hoster setup loses a Worker secret and a build env var; gains nothing.

## Why this works

Earlier sessions rejected an in-middleware "lazy auto-migrate" against D1 because Worker isolates cold-start frequently and Kysely's Migrator does ~3 D1 round trips per call (60–120ms added per cold isolate). The DO version doesn't have that problem: rwsdk's `SqliteDurableObject` caches its `initialized` flag in **the DO instance's memory**, which persists across requests to the same DO. One migration check per DO instance, then free forever.

The trade-off is single-region auth. Distant dashboard users will see ~200–400ms per page load instead of D1's read-replicated near-local latency. Audit ([`docs/worklog/2026-04-29-control-do.md`](2026-04-29-control-do.md), pre-implementation): ~12 control reads per 100-test ingest run (mostly batched / fire-and-forget) and 1–2 reads per dashboard page nav with no caching today. Ingest is unaffected; the dashboard hot path takes the latency hit. Mitigation if it ever matters: KV-cache session/membership reads (~50 LOC). Deferred until traffic justifies it.

## Architectural details

| Component                                                                                                 | File(s)                                        |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ControlDO` class extending `SqliteDurableObject`                                                         | `packages/dashboard/src/control/control-do.ts` |
| Schema as Kysely-DSL migration (camelCase identifiers throughout — same convention as TenantDO)           | `packages/dashboard/src/control/migrations.ts` |
| `getControlDb()` returning `Kysely<ControlDatabase>` + `batchControl()` for atomic multi-statement writes | `packages/dashboard/src/control/internal.ts`   |
| `ControlDatabase` type inferred via `Database<typeof controlMigrations>`                                  | `packages/dashboard/src/control/index.ts`      |
| Worker re-export so Cloudflare can find the DO class                                                      | `packages/dashboard/src/worker.tsx`            |
| `wrangler.jsonc` binding (`CONTROL`) + `new_sqlite_classes: ["ControlDO"]` migration entry                | `packages/dashboard/wrangler.jsonc`            |

Better Auth's `kyselyAdapter` is repointed at `getControlDb()` and works without changes — its TS-side field names are already camelCase, so they pass through directly to the camelCase columns in ControlDO's SQLite. The previous `CamelCasePlugin` (which translated camelCase TS to snake_case D1 columns) is no longer needed.

`batchControl()` mirrors `batchTenant()`: compile queries on the worker, send the tuple list to ControlDO via RPC, wrap in `ctx.storage.transactionSync()` for atomic multi-statement semantics. Replaces the old D1-batch helper that used `env.DB.prepare().batch()`.

## Code paths swapped

All `getDb()` call sites now use `getControlDb()` (signatures identical):

- `packages/dashboard/src/lib/auth.ts` — API-key validation.
- `packages/dashboard/src/lib/authz.ts` — team/project resolvers, role checks, suggested teams.
- `packages/dashboard/src/lib/better-auth.ts` — Better Auth's adapter.
- `packages/dashboard/src/lib/github-orgs.ts`, `src/lib/user-state.ts`.
- `packages/dashboard/src/tenant/index.ts` — `tenantScopeForUser` / `tenantScopeForApiKey`.
- `packages/dashboard/src/scheduled.ts` — cron watchdog's `lastActivityAt` read.
- `packages/dashboard/src/routes/api/runs.ts`, `routes/api/team-suggestions.ts`.
- All settings pages under `src/app/pages/settings/` plus `src/app/pages/invite.tsx`, `project-picker.tsx`.

Tests updated to mock `@/control` instead of `@/db`. `makeTestDb()` helper now returns `Kysely<ControlDatabase>` without a plugin layer.

## Local dev

`scripts/setup-local.mjs` no longer runs `wrangler d1 migrations apply --local` — miniflare provisions the DO locally and ControlDO migrates lazily on first request. The old `seed-demo.mjs` used `wrangler d1 execute` to write the demo user / team / project / api-key directly into D1; with D1 gone, that's not possible from a Node script (DO bindings only exist inside the worker).

The new `seed-demo.mjs` drives the running dev server over HTTP — same shape as how the reporter ingests test data:

1. POST `/api/auth/sign-up/email` with the demo credentials → Better Auth creates the user + account in ControlDO and returns a session cookie.
2. POST `/settings/teams/new` form-encoded `name=Demo` with the cookie → team-new server action creates the team + membership.
3. POST `/settings/teams/demo/projects/new` → project-new server action creates the project.
4. POST `/settings/teams/demo/p/playwright/keys` with `action=create` → reveals the plaintext API key in a `wrightful_reveal_key` Set-Cookie header.
5. Save URL + key to `.dev.vars.seed.json` for the fixtures uploader.

`setup-local.mjs` orchestrates: creates `.dev.vars` (with `ALLOW_OPEN_SIGNUP=1` so the seed can sign up), starts `vite dev` via the new `startDevServerForSeed` helper (probes `/api/auth/get-session` since we have no API key yet), runs `seed-demo.mjs`, then continues with fixtures upload using the minted key.

Integration test helpers (`src/__integration__/helpers/tenant.ts`) and the e2e global setup (`packages/e2e/vitest.globalSetup.ts`) — both originally seeding through `env.DB.batch` / `wrangler d1 execute` — were rewritten in the same change. The integration helper now seeds via `getControlDb()` over the `CONTROL` DO RPC binding (declared in `wrangler.test.jsonc` alongside the `v3` `ControlDO` migration entry). The e2e setup mirrors `seed-demo.mjs`'s HTTP flow (sign-up → team → project → key reveal) and wipes `wrightful-ControlDO` alongside the existing `TenantDO` / `SyncedStateServer` state directories. The deterministic `wrf_e2e_test_key_…` constant is gone; tests inject the dynamically-minted key.

Two bootstrapping gotchas worth recording — both surfaced during local verification, both caught and resolved before merge:

1. **Better Auth's CSRF guard.** The first seed run got 403 `MISSING_OR_NULL_ORIGIN` from `/api/auth/sign-up/email`. Better Auth requires an `Origin` header on POST requests. Node `fetch()` doesn't set one by default, so seed-demo now sends `Origin: ${baseUrl}` on every request. The earlier "signup is disabled" error in the script was a misleading catch-all — now narrowed to only fire when the body actually says `"Signup is disabled"`.
2. **`ALLOW_OPEN_SIGNUP` declared in `wrangler.jsonc`.** Even with `ALLOW_OPEN_SIGNUP=1` in `.dev.vars`, the binding wasn't reaching the worker reliably — the value occasionally came through as `undefined`, possibly because miniflare's binding resolution depends on the var being declared in `wrangler.jsonc`. Declaring `"ALLOW_OPEN_SIGNUP": "0"` in the `vars` block (production-safe default) gives miniflare the binding shape it needs; `.dev.vars`'s `"1"` overrides it for local dev. Self-hosters override via the dashboard env var if they want signup open in production.

Verified end-to-end on local: `pnpm setup:local` from a clean `node_modules/.vite` and stale `.dev.vars.seed.json` correctly detects the stale key, re-seeds via HTTP (signup → team → project → API key), and uploads fixture data through the new key.

## Risks accepted

1. **Existing sessions invalidate.** All sessions on the user's `wrightful` worker get nuked when they redeploy this change. They re-log-in. Acceptable for current state (test data).
2. **Single-region auth latency.** Documented above; mitigation deferred.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` passes.
- `pnpm --filter @wrightful/dashboard test` — 157/157 unit tests pass.
- `pnpm --filter @wrightful/dashboard test:integration` — 8/8 integration tests pass against the `CONTROL` DO RPC binding (no D1).
- Production code paths grep clean of `getDb` and `@/db`. The only remaining mentions of "control D1" or `wrangler d1` in `packages/` are intentional historical-context comments inside the new ControlDO module / wrangler config / setup script.
- `wrangler types --include-runtime false` regenerates with `CONTROL` typed under `Cloudflare.Env`.
- Docs (`CLAUDE.md`, `docs/ARCHITECTURE.md`, `SELF-HOSTING.md`) updated to describe the ControlDO architecture; user-facing self-hosting steps no longer reference D1.
- End-to-end remote verification belongs on the next deploy: `pnpm deploy` should be a single `wrangler deploy`, ControlDO auto-provisions, sign-up + run ingest both work.
