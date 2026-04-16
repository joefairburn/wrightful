# 2026-04-16 — E2E on Vitest `globalSetup`

## What changed

The `packages/e2e` test was a single hand-rolled `run-e2e.js` doing everything: build, migrate, seed, write fake R2 creds, spawn dev server, run Playwright to generate a fixture report, run nine hand-rolled HTTP/DB assertions, tear down. It worked but the assertion half felt out of place — reinventing a test runner.

Moved the assertions onto Vitest and the orchestration into Vitest's `globalSetup` lifecycle. `vitest run` is now the single entry point.

- `packages/e2e/vitest.globalSetup.ts` does all orchestration in `setup()` and all cleanup in `teardown()`. It exposes connection details (dashboard URL, API key, paths) to tests via `project.provide()`.
- `packages/e2e/src/e2e.test.ts` reads those values with `inject()` — no more `process.env` coupling.
- `packages/e2e/scripts/run-e2e.js` is deleted.

This happened in two steps within the same day, and landed as one change. The intermediate shape — custom script that shells out to `vitest run` — was discarded in favor of the `globalSetup` approach after it became clear that the script half was just reimplementing Vitest's lifecycle hooks.

## Why `globalSetup`

- **Single entry point.** `pnpm --filter @greenroom/e2e test` → `vitest run`. No bespoke JS driver.
- **Lifecycle guarantees.** Vitest always calls `teardown()` if `setup()` returned, including after a test throws. The named-exports form (`export function setup` + `export function teardown`) means teardown can also clean up partial setup state — we track `devServer` and `devVarsBackedUp` at module scope so teardown works regardless of where setup stopped.
- **Typed value plumbing.** `project.provide("dashboardUrl", url)` in setup + `inject("dashboardUrl")` in tests. A `declare module "vitest"` block augments `ProvidedContext` so the keys are checked at compile time.
- **Single-file iteration works.** `pnpm --filter @greenroom/e2e exec vitest run src/e2e.test.ts` triggers full setup then runs only that file.
- **Faster.** ~20s total vs ~60s before; the previous split rebuilt the CLI in two places during some runs.

## Files

| File                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/e2e/vitest.globalSetup.ts` | **New.** Named `setup`/`teardown` exports. Setup does: build CLI, `db:migrate:local`, clean + seed API key, swap `.dev.vars`, spawn `vite dev --port 5188` with buffered stdio, `waitForServer` (surfaces buffered server output on timeout), run `npx playwright test` to generate `playwright-report.json`, call `project.provide(...)` for 5 keys. Teardown kills the dev server + restores `.dev.vars`. Module-level state (`devServer`, `devVarsBackedUp`) lets teardown clean up even if setup threw partway through. |
| `packages/e2e/vitest.config.ts`      | Added `globalSetup: ["./vitest.globalSetup.ts"]`. Keeps `include: ["src/**/*.test.ts"]` so Playwright's `tests/demo.spec.ts` isn't picked up. 60s test + hook timeouts.                                                                                                                                                                                                                                                                                                                                                     |
| `packages/e2e/src/e2e.test.ts`       | **New.** Nine original tests regrouped into four `describe` blocks: empty state, ingest auth + validation, CLI upload + dashboard render, artifacts presign. Reads config via `inject("dashboardUrl")` etc.                                                                                                                                                                                                                                                                                                                 |
| `packages/e2e/package.json`          | `"test": "vitest run"` (was `node scripts/run-e2e.js`). Added `vitest: ^3.0.0` devDep.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/e2e/tsconfig.json`         | Added `src` and `vitest.globalSetup.ts` to `include`; removed `scripts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/e2e/scripts/run-e2e.js`    | **Deleted.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Notable behavior details

- **Seeded presign data is read once per `describe`, not per test.** The presign block's `beforeAll` runs `wrangler d1 execute` once and shares `runId` + `testResultId` across the three presign tests. Without this, the last presign test flaked with `ECONNRESET` — the dev server appears to briefly drop connections during `.dev.vars` / sqlite file activity, and a second D1 shell-out close to the first triggered it.
- **Dev server output is surfaced on startup failure.** `waitForServer`'s stdout/stderr buffer used to be a silent sink; now it prints on timeout so "did not start within 40s" is actually debuggable.
- **Teardown writes run unconditionally.** `teardown()` kills the dev server (if spawned) and restores `.dev.vars` (if backed up), keying off module-level flags so it's safe even when `setup()` threw before completing.

## What we chose NOT to do

- **Playwright as the test harness.** The assertions are HTTP + D1 integration checks, not browser flows. Playwright stays in its fixture-generator role.
- **Docker / Testcontainers.** Overkill — the sandbox is already a local dev server + ephemeral D1 rows cleaned at setup time.
- **`@cloudflare/vitest-pool-workers`.** Tests Workers code inside Miniflare in isolation, which doesn't cover the full Vite + dev-server path we care about here.
- **Unify Playwright and Vitest runs.** Playwright's `tests/` and Vitest's `src/` stay separate. Vitest's `include` skips `tests/**`.

## Dependency bump

Alongside the restructure, bumped `vitest` 3.2.4 → 4.1.4 and `@playwright/test` 1.50.0 → 1.59.1 across the workspace.

- **Vitest 4** changed `vi.restoreAllMocks()` semantics: it no longer clears the call history of `vi.fn()` instances — it only restores original implementations. `packages/cli/src/__tests__/api-client.test.ts` shared one `mockFetch` across tests and relied on the v3 clearing behavior, which caused false call-count assertions after the bump. Fix was one line: `mockFetch.mockClear()` in the `beforeEach`.
- Vitest 4 peer deps require `vite ^6 || ^7 || ^8` — dashboard is on `vite ~7.3.2`, so compatible.
- Playwright 1.59.1 is within the 1.x series that `packages/cli/src/__tests__/playwright-compat.test.ts` is designed to cover.

## Verification

- `pnpm --filter @greenroom/cli test` — 83/83 pass on vitest 4.
- `pnpm --filter @greenroom/dashboard test` — 43/43 pass on vitest 4.
- `pnpm --filter @greenroom/e2e test` — 11/11 pass end-to-end on vitest 4 + playwright 1.59.1. Total ~20s.
- `pnpm lint` — 5 pre-existing warnings (`cli/src/lib/api-client.ts`, `dashboard/src/lib/status.ts`, `dashboard/src/app/pages/test-history.tsx`). No new warnings.
- `packages/e2e` and `packages/dashboard` typecheck clean under tsgo. `packages/cli` has pre-existing tsgo errors (`Cannot find name 'process'`, `node:crypto` etc. — `@types/node` not picked up under tsgo's resolution); verified these fail on the committed state too, so unrelated to this change.
- `oxfmt --check` on changed files — clean.
