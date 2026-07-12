# 2026-07-12 — Playwright best-practices pass over the e2e suite

## What changed

A review of `packages/e2e` against Playwright best practices (resilient
locators, web-first assertions, fixtures over shared state, no hard
sleeps/`networkidle`, minimal reporters in CLI contexts) surfaced ten findings;
all ten were applied. No test semantics changed — every assertion asserts the
same thing as before; the changes are about _how_ the suite waits, locates,
and shares setup.

## Details

| #   | Finding                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `realtime.spec.ts` settled the room WebSocket with a fixed `waitForTimeout(800)`                                                                 | `gotoAndAwaitRoom` now collects matching `websocket` events via a listener attached before navigation: waits for the first connect (same 20s/30s bound), then a bounded (2s, best-effort) wait for a possible second connect — the dev-mode remount reconnect — so streaming never targets a socket about to be torn down. No fixed sleep.                 |
| 2   | `login.page.ts` `waitForClientSettled` used `networkidle`, which two other files in the suite explicitly reject for this app                     | Now waits for the one request that _is_ the post-hydration re-nav: Void's client router tags page-data fetches with `X-VoidPages: true` (see `loadNavigationShell` in void `dist/pages/client.mjs`); matched together with the current pathname, with a 5s bounded `.catch()` fallback. Listener attaches before `goto()` to avoid the settle racing past. |
| 3   | `auth.spec.ts` duplicated the settle inline (`goto` + `networkidle`) in the two `?next` tests                                                    | `gotoSignIn(query?)` accepts a raw query string; both call sites route through the page object. Settle logic now lives in exactly one place.                                                                                                                                                                                                               |
| 4   | `test-replay.spec.ts` used an XPath parent-hop (`locator("xpath=..")`)                                                                           | Row recovered with the suite's filter idiom: `div.group` rows filtered by `has:` the Replay button and the detail link (markup evidence: `TestRow` in `run-progress-row.tsx` renders link + button as siblings).                                                                                                                                           |
| 5   | Styling-class locators: `div.mb-4` (group card), all-divs+`.last()` (key row), `div.sticky.top-0` (run header)                                   | Added `data-testid="group-card"` / `"key-row"` / `"run-header"` in the app (via optional `data-testid` props threaded through `SettingsCard` and `DetailHeaderBar`; plain attribute on the key row div) and switched `groups.page.ts` `card()`, `api-keys.page.ts` `rowFor()` (no more `.last()`), and `realtime.spec.ts` to `getByTestId`.                |
| 6   | `cross-tenant.spec.ts` used `beforeAll` + module-level `let teamBRunId` + per-test `if (!teamBRunId) throw` guards                               | Worker-scoped `secondTenant` fixture (extends the shared `test`, depends on the existing worker-scoped `ctxWorker` + built-in `playwright`), seeding user B/team B/project B/key B/run once per worker and handing tests `{ runId, teamSlug, projectSlug }`. Guards deleted.                                                                               |
| 7   | Demo (`playwright.config.ts`) and load (`playwright.load.config.ts`) configs always used the `list` reporter                                     | Same `CI \|\| CLAUDE → line` guard as the dashboard config. Matters most for the load config (up to 1000 generated tests).                                                                                                                                                                                                                                 |
| 8   | `groups.spec.ts` duplicate-name test had success-path-only cleanup                                                                               | Cleanup deleted — the name is timestamped and global-setup resets the DB, so it protected nothing and could mask a failure's real state.                                                                                                                                                                                                                   |
| 9   | The runs-list → `firstRunId()` → run-detail preamble was duplicated across 8 tests in 5 spec files                                               | New test-scoped `openSeededRun(branch?)` fixture in `fixtures.ts`; converted call sites in `test-detail`, `test-replay`, `run-detail`, `a11y`, `visual` specs. The one `run-detail` test asserting on the raw `goto()` Response was deliberately left as-is.                                                                                               |
| 10  | `logout.spec.ts` asserted a 3-way boolean disjunction (opaque failure); `monitors.page.ts` had an unused, unscoped `getByRole("switch")` locator | Logout assertion restructured to name the cookie and the violated condition; dead `enabledSwitch` property removed (grep-verified unused).                                                                                                                                                                                                                 |

App-source impact is confined to test hooks: two components gained an optional
`data-testid` pass-through prop and three call sites set one; no behavior
change.

## Verification

- `pnpm check` (vp check: format + lint + type-aware typecheck): **0 errors**;
  139 pre-existing warnings, none in any touched file (grep-verified).
- `pnpm --filter @wrightful/dashboard typecheck` (`void prepare` + `tsgo`): clean.
- Full dashboard e2e suite (`test:dashboard`, isolated `wrightful_dev_e2e` DB):
  **48 passed / 3 failed / 1 skipped** (visual, env-gated). The 3 failures
  (`a11y` run-detail, `monitors` stub-executor cycle, `test-detail` first test)
  were then re-run in isolation and **all 9 tests in those files passed** —
  they are the suite's documented shared-dev-server flake modes (CI absorbs
  them with `retries: 2`; local runs use `retries: 0`), on code paths this
  pass did not change semantically. Every test in the suite passed at least
  once across the two runs; the specs that exercise the changed machinery
  (realtime WS settle, login/auth settle, cross-tenant fixture, groups/api-keys
  testid locators) all passed in the full run.
- `--list` config loads verified for the demo and load configs after the
  reporter changes (5 and 1000 tests discovered respectively).
- Note: the suite requires `pnpm --filter @wrightful/reporter build` first —
  the dashboard config registers `@wrightful/reporter` as a streaming reporter
  and Playwright resolves its `dist/` at config load.
