# 2026-04-20 — Per-tenant Durable Objects + Drizzle → Kysely

Shards tenant-owned data out of the single control D1 into a per-team
SQLite-backed Durable Object, and migrates the whole codebase from Drizzle
to Kysely so the two sides speak one query builder.

## What changed

Three milestones landed on the same branch:

1. **M1 — Drizzle → Kysely on the control DB.** Swap the query builder
   without moving any data. Every control-side call site compiles against a
   Kysely `DB` interface; Better Auth uses `kyselyAdapter` instead of
   `drizzleAdapter`. Behaviourally a no-op at the D1 boundary.
2. **M2 — Introduce the tenant DO.** Add `TenantDO` (extends rwsdk's
   `SqliteDurableObject<TenantDB>`) and the `getTenantDb` helper. Nothing
   reads or writes it yet — just the binding, the class, and the migrations.
3. **M3 — Cut the reads/writes.** Route every `runs` / `testResults` /
   `testTags` / `testAnnotations` / `testResultAttempts` / `artifacts` touch
   through the team's DO. Redesign the artifact download token to carry the
   R2 key (no DB lookup on GET). Rework the cron watchdog to fan out per
   team, filtered by a new `teams.lastActivityAt` column on the control DB.

## Why

D1 caps at 10 GB per database, and test-result ingest is the dominant
growth workload. Past a few hundred active tenants the ceiling becomes a
product blocker that no amount of `projectId` filtering discipline can fix.

While making the cut, Drizzle → Kysely falls out naturally:

- `rwsdk/db` is Kysely-native (`SqliteDurableObject<T>` owns a
  `Kysely<T>`; `createDb()` returns a Kysely handle with the
  `DOWorkerDialect`).
- Better Auth ships a first-class `kyselyAdapter` — drop-in swap.
- One query builder across worker + DO is simpler than two.

## Key design decisions

| Decision                                   | Choice                                                                            | Why                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Shard key                                  | Team (one DO per team)                                                            | Matches the tenancy model. Cross-team operations are rare; within-team they stay hot.                               |
| Tenant data layer                          | `rwsdk/db`                                                                        | First-class SQLite + Kysely + migrations. Owns its own DO class.                                                    |
| Control DB dialect                         | `kysely-d1`                                                                       | Canonical D1 dialect for Kysely.                                                                                    |
| Identifier style (control D1)              | CamelCasePlugin + snake_case columns                                              | Preserves Better Auth's canonical SQL layout; TS surface stays camelCase.                                           |
| Identifier style (tenant DO)               | camelCase everywhere, no plugin                                                   | Matches rwsdk/db conventions — migrations are the single source of truth, types inferred directly from the DSL.     |
| Timestamps                                 | INTEGER unix seconds (`number` in TS)                                             | Explicit, no plugin indirection; `date-fns` and `formatRelativeTime` accept `number` directly.                      |
| Booleans                                   | INTEGER 0/1 (`number` in TS)                                                      | Matches SQLite storage; no Kysely plugin needed.                                                                    |
| Atomic multi-statement writes on tenant DO | `ctx.storage.transactionSync` via a `TenantDO.batchExecute(queries)` RPC          | Both `DOWorkerDialect` and `kysely-do` throw on BEGIN/COMMIT, so transactional batches have to live on the DO side. |
| Artifact download auth                     | HMAC token carries `{ r2Key, contentType, exp }`                                  | Lets the download handler stream from R2 without a DO round-trip.                                                   |
| Watchdog fan-out                           | Control DB `teams.lastActivityAt` filter + per-team `TenantDO.sweepStuckRuns` RPC | Bounds sweep cost to active teams; idle teams are a no-op.                                                          |

## Details

### New packages / files

- Dependencies: add `kysely`, `kysely-d1`, `@better-auth/kysely-adapter`,
  `tsx` (dev). Remove `drizzle-orm`, `drizzle-kit`, `drizzle.config.ts`.
- `packages/dashboard/src/db/batch.ts` — `batchD1(queries)` helper. Compiles
  Kysely queries and hands them to `env.DB.batch(...)` for atomic
  multi-statement writes on the control DB (only `team-new`'s
  team+membership insert uses this post-M3).
- `packages/dashboard/src/tenant/migrations.ts` — in-code `0000_init`
  migration using rwsdk/db's Kysely schema DSL. Every `createTable` result
  is returned from `up()` so the types flow through
  `Database<typeof tenantMigrations>`. Runs inside each DO on first
  touch via rwsdk/db's InMemoryMigrationProvider.
- `packages/dashboard/src/tenant/tenant-do.ts` —
  `class TenantDO extends SqliteDurableObject { migrations = tenantMigrations }`.
  Adds `batchExecute(queries)` for atomic writes and
  `sweepStuckRuns(cutoff, now)` for the watchdog.
- `packages/dashboard/src/tenant/index.ts` — `getTenantDb(teamId)` wraps
  `createDb<TenantDatabase>(env.TENANT, teamId)` with `TenantDatabase =
Database<typeof tenantMigrations>` (inferred). Also exports
  `batchTenant(teamId, queries)` — compiles on the worker and RPCs
  `TenantDO.batchExecute`. No hand-written schema interface, no
  `CamelCasePlugin` bridge — the migration is the single source of truth.

### Schema changes

- `teams.lastActivityAt` (INTEGER, nullable, indexed) on control D1 —
  bumped on every ingest write. Watchdog reads it to skip idle teams.
- Tenant DO tables (`runs`, `testResults`, `testTags`, `testAnnotations`,
  `testResultAttempts`, `artifacts`) are camelCase in both TS and SQLite.
  Indexes use camelCase column names too.
- `committedRuns` view dropped. rwsdk/db type inference only sees tables
  (not views), and `runs.committed` is always `1` under streaming ingest —
  the legacy bulk-ingest two-phase commit is gone. Read sites that used the
  view now filter on `runs.committed = 1` at the call site; the default
  predicate lives in `buildRunsWhere` (shared across runs list + filters).
- Control D1 no longer has `runs`, `test_results`, `test_tags`,
  `test_annotations`, `test_result_attempts`, `artifacts`, or the
  `committed_runs` view — they all moved to the tenant DO.
- Pre-launch squash policy applied: `migrations/0000_init.sql` (control
  D1) is regenerated in place, not stacked.

### Wrangler config (`packages/dashboard/wrangler.jsonc`)

- New DO binding: `{ name: "TENANT", class_name: "TenantDO" }`.
- New migration tag: `{ tag: "v2", new_sqlite_classes: ["TenantDO"] }`
  (v1 stays for `SyncedStateServer`).
- `migrations_dir` moved from `drizzle` to `migrations`.

### Worker entry (`packages/dashboard/src/worker.tsx`)

- `export { TenantDO } from "@/tenant/tenant-do";` so the runtime registers
  the class under the `TENANT` binding.

### Request flow (post-M3)

1. Session → control DB (Better Auth via `kyselyAdapter`).
2. Route → `resolveTeamBySlug` / `getActiveProject` (control DB) → `teamId`.
3. `getTenantDb(env.TENANT, teamId)` → Kysely handle for tenant reads/writes.
4. Ingest → API key (control DB) → `projectId` → `resolveTenantScope` to
   get `{ teamId, teamSlug, projectSlug }` → tenant DO for the writes.

### Artifact download token redesign

Pre-M3: token signed `${artifactId}.${exp}`. Download handler looked up
`artifacts.r2Key` from D1 on every GET.

Post-M3: token signs `base64url(JSON({ r2Key, contentType, exp }))`.
Download handler verifies the signature and streams from R2 directly —
no DB hop. Token-issuing sites (test-detail page, run-detail via
`loadFailingArtifactActions`) read `r2Key` + `contentType` into the tenant
SELECT and pass them through to `signArtifactToken`.

### Watchdog (`src/scheduled.ts`)

```
now + stale_minutes → cutoff
SELECT id FROM teams WHERE last_activity_at >= cutoff
  ↓ per-team RPC ↓
TenantDO.sweepStuckRuns(cutoff, now) →
  UPDATE runs SET status='interrupted', completed_at = now
    WHERE status='running' AND created_at < cutoff
  RETURNING id, created_at
```

One-team failure is logged (`watchdog.team_sweep_failed`) but does not
abort other teams. Per-run audit logs (`watchdog.run_interrupted`)
preserve `teamId` + `runId` + `createdAt` for later debugging.

## Tradeoffs / follow-ups

- **Orphan cleanup on project delete** — deleting a project removes its
  control-DB row but leaves `runs` / `testResults` / `artifacts` rows in
  the team's DO. Not addressed in this PR. Follow-up: a tenant-DO RPC that
  deletes rows by `projectId`, called from the project-delete handler.
- **Param chunking on tenant writes** — the tenant DO's SQLite doesn't
  enforce D1's 100-param-per-statement cap, but `runs.ts` and
  `artifacts.ts` still chunk multi-row inserts. Kept as a defensive
  bound, not a correctness requirement. Can be relaxed later if the batch
  size becomes a bottleneck.
- **Test-side mocks** — tests that import handlers touching `@/tenant`
  mock the module so `rwsdk/db`'s unextensioned `import "../debug"` doesn't
  trip the ESM loader. Upstream issue to track.

## Verification

- `pnpm typecheck` — clean (dashboard + reporter).
- `pnpm test` — 132/132 pass (dashboard) + 23/23 (reporter).
- `pnpm format` — clean (after `pnpm format:fix`).
- `pnpm lint` — dashboard introduces no new issues; pre-existing
  `@typescript-eslint/no-unsafe-type-assertion` errors in
  `packages/reporter/src/client.ts` predate this work.
- `pnpm --filter @wrightful/dashboard db:migrate:local` — 21 commands
  apply cleanly from an empty DB.
- Manual smoke (user-side, per CLAUDE.md): sign up → create teams A and B
  → create project + API key in A → `pnpm test:e2e` with reporter
  pointing at local → confirm results appear in A, don't appear in B.
