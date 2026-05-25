# 2026-05-22 — Void migration tests: foundation only

Follow-up to `2026-05-22-void-migration-complete.md` and
`2026-05-22-void-audit-tightening.md`. Both prior worklogs explicitly
deferred two workstreams that block deleting the legacy
`packages/dashboard`:

1. Porting 38 unit tests + 4 integration tests from the rwsdk/Kysely
   dashboard to dashboard-void.
2. Writing the ETL from live `ControlDO` + per-team `TenantDO` storage
   into the new D1.

This worklog covers a **partial first cut** — the load-bearing
infrastructure for (1) and the schema audit for (2). The full ports +
ETL scripts are deferred to a follow-up session.

## What changed

### Test infrastructure (`packages/dashboard-void/`)

- **`vite.config.ts`** — switched the `defineConfig` import from `vite`
  to `vitest/config` so the `test:` block typechecks. Added a `isTest`
  branch that:
  - Drops `voidPlugin()` + `voidReact()` under vitest (they try to
    bootstrap D1 migrations and wrap test modules as Workers, which
    crashes the runner with `ReferenceError: module is not defined`).
  - Adds `@schema` and `void/db` aliases pointing at the schema source
    file and a test-only stub, so SUT code that imports those virtual
    modules resolves under plain Node.
  - Sets `test.environment` to `happy-dom` and limits `test.include` to
    `src/**/__tests__/**/*.test.{ts,tsx}`.
- **`src/__tests__/helpers/void-db-stub.ts`** — re-exports Drizzle
  operator names (`eq`, `and`, `or`, `sql`, …) as identity-style
  placeholders, plus a `db` Proxy that throws if any property is read.
  Pure-function tests only need the import to resolve; DB-touching tests
  will `vi.mock("void/db", …)` with a real instance.

### Unit tests ported (group 1 — pure functions)

Six test files into `packages/dashboard-void/src/__tests__/`:

| File                          | SUT                                             | Notes                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemas.test.ts`             | `@/lib/schemas`                                 | Zod wire-protocol schemas. Verbatim port, only import path changed.                                                                                                                                                                        |
| `safe-next-path.test.ts`      | `@/lib/safe-next-path`                          | Verbatim port.                                                                                                                                                                                                                             |
| `group-tests-by-file.test.ts` | `@/lib/group-tests-by-file`                     | Verbatim port. `RunProgressTest` type pulled from `@/lib/live-client` (the new module shape).                                                                                                                                              |
| `active-project.test.ts`      | `@/lib/active-project`                          | **Rewritten.** Old version asserted on a rwsdk `requestInfo.ctx` shape and a Kysely-backed `tenantScopeFromIds`. New `getActiveProject(c)` is a one-line Hono context reader; new tests cover that + `requireActiveProject` 404 behaviour. |
| `aggregate-delta.test.ts`     | `computeAggregateDelta` (now in `@/lib/ingest`) | Verbatim port. Dropped the obsolete `vi.mock("cloudflare:workers" / "@/control" / "@/tenant")` calls.                                                                                                                                      |
| `build-changed-tests.test.ts` | `buildChangedTests` (now in `@/lib/ingest`)     | Verbatim port. Same mock cleanup.                                                                                                                                                                                                          |

### Skipped from group 1

- **`seed-generator.test.ts`** — no equivalent module in `dashboard-void/src/lib/`. The seed generator was a legacy demo-data utility; not carried over.
- **`frozen-migrations.test.ts`** — the concept does not apply: void's
  migrations are managed by `void db generate` + a single
  `db/migrations/` directory, not the rwsdk runtime migration runner.

## Verification

```bash
cd packages/dashboard-void
pnpm test         # 6 files, 81 assertions, all green
pnpm check        # 0 errors, 77 warnings (baseline from audit-tightening)
```

`pnpm test` output:

```
Test Files  6 passed (6)
     Tests  81 passed (81)
  Duration  ~730ms
```

## Deferred — explicit punch list

Captured here so future sessions don't have to re-derive scope:

### Workstream 1: remaining unit tests

Roughly **30** unit tests + **7** React component tests still to port.
Many require a real-DB harness (in-memory SQLite via better-sqlite3
through Drizzle's SQLite dialect — same wire format as D1) because the
SUT is a Drizzle query path, not a pure function. The harness has not
been built yet; the existing test-db stub only covers pure-function
tests.

Buckets, mapped to dashboard-void target modules:

- **Authz / control (7):** `authz.test.ts`, `authz-bundle.test.ts`,
  `invites.test.ts`, `signup.test.ts`, `auth.test.ts`,
  `middleware.test.ts`, `user-state.handler.test.ts` — target
  `src/lib/authz.ts`, `src/lib/scope.ts`, signup actions.
- **Tenant / ingest (11):** `runs.test.ts`, `run-results.test.ts`,
  `ingest-error-paths.test.ts`, `run-summary.test.ts`,
  `run-tests-tail.test.ts`, `run-detail-scoping.test.ts`,
  `run-test-preview.handler.test.ts`,
  `test-result-summary.handler.test.ts`, `runs-filters.test.ts`,
  `artifacts.test.ts` — target `src/lib/ingest.ts` + route handlers.
  `run-progress-broadcast.test.ts` is **obsolete** (no `SyncedStateServer` DO; live state uses void primitives) — drop, don't port.
- **Artifacts / scheduled (3):** `artifact-download.test.ts`,
  `artifact-upload.test.ts`, `scheduled.test.ts`.
- **React components (7):** `charts.test.tsx`,
  `components/error-page.test.tsx`,
  `components/flaky-test-row.test.tsx`,
  `components/login-form.test.tsx`,
  `components/runs-filter-bar.test.tsx`,
  `components/status-badge.test.tsx`,
  `components/visual-diff-dialog.test.tsx`. Should be mostly
  mechanical — only import paths change.

### Workstream 1: integration tests

Old `packages/dashboard/src/__integration__/{tenant-ingest,tenant-migrations}.test.ts` need rewrites:

- **`tenant-ingest`** — boot the void app's fetch handler in-process,
  fire HTTP requests, assert end-to-end against an in-memory D1.
- **`tenant-migrations`** — replaced by an idempotency assertion against
  `db/migrations/*.sql`.
- **New:** `auth-flow.test.ts`, `ingest-happy-path.test.ts` to cover
  surfaces that didn't exist in the old stack.

Decision: use plain vitest, not `@cloudflare/vitest-pool-workers`.
Wrangler dependency for tests was removed when we left rwsdk.

### Workstream 2: ETL

Schema audit shipped at `docs/etl/legacy-to-d1-mapping.md`. The actual
scripts are not written:

- `scripts/etl/01-list-teams.mjs` — wrangler RPC into ControlDO
- `scripts/etl/02-dump-control.mjs` — JSONL dump of every ControlDO table
- `scripts/etl/03-dump-tenants.mjs` — per-team JSONL dump from each
  TenantDO
- `scripts/etl/04-transform-load.mjs` — apply mapping, batch-insert
  into D1 (FK-safe order, idempotent `INSERT OR REPLACE`)
- `scripts/etl/05-verify.mjs` — row-count + hash sample + R2 HEAD spot
  check, writes `.etl-cache/verify-report.json`

All scripts must support `--dry-run` against a staging D1 binding
before any production target. Writing them requires production wrangler
credentials and a staging tenant to validate against; deferred for a
session with both.

### Workstream 2: ETL unit tests

Three tests planned under `src/__tests__/etl/`:

- `mapping.test.ts` — per-table transform fixtures
- `verify-rowcounts.test.ts` — verifier flagging behaviour
- `idempotency.test.ts` — double-load row stability

Blocked on the ETL scripts existing.

## Files changed in this pass

- `packages/dashboard-void/vite.config.ts` (test config, isTest branch)
- `packages/dashboard-void/src/__tests__/helpers/void-db-stub.ts` (new)
- `packages/dashboard-void/src/__tests__/active-project.test.ts` (new)
- `packages/dashboard-void/src/__tests__/aggregate-delta.test.ts` (new)
- `packages/dashboard-void/src/__tests__/build-changed-tests.test.ts` (new)
- `packages/dashboard-void/src/__tests__/group-tests-by-file.test.ts` (new)
- `packages/dashboard-void/src/__tests__/safe-next-path.test.ts` (new)
- `packages/dashboard-void/src/__tests__/schemas.test.ts` (new)
- `docs/etl/legacy-to-d1-mapping.md` (new)
- `docs/worklog/2026-05-22-void-tests-foundation.md` (this file)
