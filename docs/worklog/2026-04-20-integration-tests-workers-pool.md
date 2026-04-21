# 2026-04-20 — Integration tests via `@cloudflare/vitest-pool-workers`

Adds a second vitest project that runs tests inside a real
workerd/miniflare instance, exercising the tenant Durable Object, its
`rwsdk/db`-managed migrations, and the full streaming-ingest flow against
a real D1 + real DO — no mocks.

## What changed

- **Two-project vitest config.** `packages/dashboard/vitest.config.ts`
  declares `test.projects = [unit, integration]`. The unit project keeps
  the default Node pool + existing `src/__tests__/**/*.test.ts` glob
  (132 tests, unchanged). The integration project uses
  `@cloudflare/vitest-pool-workers` + `src/__integration__/**/*.test.ts`
  (8 tests, new).
- **npm scripts.**
  - `pnpm test` — unit only (default, ~2s).
  - `pnpm test:watch` — unit watch mode.
  - `pnpm test:integration` — workers-pool tests only.
  - `pnpm test:all` — both projects.
- **Dedicated test wrangler config.** `packages/dashboard/wrangler.test.jsonc`
  — minimal: `TENANT` DO binding + `v1` migration tag, `DB` D1 binding,
  `R2` bucket, `BETTER_AUTH_SECRET` var. No rate limiters, no cron
  triggers, no observability. Points at a test-only entrypoint.
- **Minimal test entrypoint.** `src/__integration__/entrypoint.ts`
  exports just `TenantDO` + a no-op `fetch`. The production
  `src/worker.tsx` pulls in the full rwsdk router + `SyncedStateServer`,
  which requires dev-server-level resolve plumbing the test pool doesn't
  satisfy. Tests call handlers / DO RPCs directly, so the router is
  unnecessary.
- **Integration helpers.** `src/__integration__/helpers/tenant.ts` —
  `ensureControlSchema()` (applies control-D1 migrations via the pool's
  `applyD1Migrations`), `freshTeamId()`, and `seedTeamAndProject()` so
  each test works against its own pristine tenant DO + seeded team/project.
- **Tests landed.**
  - `src/__integration__/tenant-migrations.test.ts` — 6 tests. Verifies
    every expected table + index is created on first DO touch, runs a
    full insert/select round-trip, asserts `batchExecute` rollback is
    atomic (via `runInDurableObject` so the constraint throw stays
    in-process), and asserts `sweepStuckRuns` picks only stale running
    rows.
  - `src/__integration__/tenant-ingest.test.ts` — 2 tests. Runs the full
    reporter-facing flow: `openRunHandler` → `appendResultsHandler` →
    `completeRunHandler`, then reads back via `composeRunProgress` and
    asserts aggregates, tests, tags, annotations, and attempt rows.
    Second test verifies idempotency-key replay returns the existing
    `runId`.

## Key design decisions

| Decision                                  | Choice                                           | Why                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test pool                                 | `@cloudflare/vitest-pool-workers@^0.14.8`        | Latest peer-supports `vitest@^4.1` — matches our existing vitest 4.1.4.                                                                                                                                                                                          |
| Config shape                              | Vite plugin (`cloudflareTest()`)                 | vitest 4 dropped `pool: "@cloudflare/vitest-pool-workers"` string form; the pool ships `cloudflareTest` as a plugin that sets `config.poolRunner`.                                                                                                               |
| Entry for integration pool                | Dedicated `entrypoint.ts`, not `src/worker.tsx`  | rwsdk's worker-side modules (`rwsdk/worker`, `rwsdk/use-synced-state/worker`) require `react-server` + `workerd` export conditions the pool doesn't apply uniformly, so loading the production entry fails at Vite import-analysis.                              |
| Fresh state per test                      | Unique `teamId` per test (ULID)                  | DO isolation gives us a clean SQLite instance per `idFromName(teamId)` — no teardown needed.                                                                                                                                                                     |
| Control-D1 seeding                        | `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` | `readD1Migrations("./migrations")` runs at Node layer in the vitest config and injects the migrations as a miniflare binding.                                                                                                                                    |
| `transactionSync` rollback assertion      | `runInDurableObject` over raw storage            | Going through the RPC boundary with a throwing `transactionSync` surfaces an extra unhandled-in-promise log in workerd even though the caller observes the rejection. Running the transaction in-process via `runInDurableObject` keeps the throw inside the DO. |
| `exec().toArray()` inside the transaction | Added                                            | Forces the cursor to drain within `transactionSync` so constraint errors surface synchronously rather than lazily on the next microtask.                                                                                                                         |

## Files touched

| File                                                               | Purpose                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `packages/dashboard/vitest.config.ts`                              | Project split + `cloudflareTest` plugin + `TEST_MIGRATIONS` binding                               |
| `packages/dashboard/wrangler.test.jsonc`                           | Test-only wrangler config (TENANT binding, D1, R2, vars)                                          |
| `packages/dashboard/tsconfig.json`                                 | Added `@cloudflare/vitest-pool-workers/types` to `types` so tests resolve `cloudflare:test`       |
| `packages/dashboard/package.json`                                  | Scripts: `test` (unit), `test:integration`, `test:all`; `@cloudflare/vitest-pool-workers` dev dep |
| `packages/dashboard/src/__integration__/entrypoint.ts`             | Minimal worker entry for tests                                                                    |
| `packages/dashboard/src/__integration__/helpers/tenant.ts`         | Shared helpers (`ensureControlSchema`, `freshTeamId`, `seedTeamAndProject`)                       |
| `packages/dashboard/src/__integration__/tenant-migrations.test.ts` | Migration + DO RPC coverage                                                                       |
| `packages/dashboard/src/__integration__/tenant-ingest.test.ts`     | End-to-end ingest coverage                                                                        |
| `packages/dashboard/src/tenant/tenant-do.ts`                       | `.toArray()` inside `batchExecute` to force cursor drain                                          |

## Rough wall-clock

- `pnpm test` (unit): ~2s, 132 tests.
- `pnpm test:integration`: ~2.5s, 8 tests (miniflare startup dominates).
- `pnpm test:all`: ~3s, 140 tests.

## Verification

- `pnpm typecheck` — clean.
- `pnpm test` — 132/132 pass, unchanged.
- `pnpm test:integration` — 8/8 pass.
- `pnpm test:all` — 140/140 pass.
- `pnpm format` — clean.

## Open items / follow-ups

- **Coverage gaps.** No integration tests yet for: artifact register +
  upload round-trip against real R2, `artifactDownloadHandler` token
  verification, RSC page reads (`RunDetailPage`, `RunsListPage`, etc.).
  Incremental adds — the infrastructure is in place.
- **Workerd websocket exception log.** Each integration run emits a
  `workerd/api/web-socket.c++:821: disconnected` line after the test
  summary. Cosmetic (tests pass, exit 0). Probably the pool's own
  teardown; not our code.
- **CI wiring.** Whichever workflow runs `pnpm test` today will keep
  running unit-only. Add a separate job (or swap to `test:all`) to get
  the integration pool in CI.
