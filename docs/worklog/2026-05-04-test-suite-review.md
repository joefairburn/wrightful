# 2026-05-04 — Test suite review: parallelize Playwright, split route-handlers, scope reporter fake timers

## What changed

A review pass over the Vitest + Playwright suites against best practices.
No correctness regressions; six structural improvements:

1. **Playwright UI suite goes parallel.** `workers: 1` was load-bearing
   for one reason — `logout.spec` invalidates the shared session token,
   401-ing every other concurrent worker. Fixed by minting a throwaway
   session row for that test only; the shared `storageState.json`
   session is no longer touched. `workers` is now `undefined` locally
   (Playwright auto-picks based on cores) and `3` in CI.
2. **`route-handlers.test.ts` (581 LOC, 12 `vi.mock` calls, 5 handlers)
   split per handler** so failures localise. Each new file mocks only
   what its handler needs.
3. **Reporter `client.test.ts` fake timers scoped.** Outer describe ran
   on fake timers blanket-style (24 `runAllTimersAsync` call sites);
   only the retry/backoff path actually needs them. Non-retry tests now
   run on real timers and just `await client.method()` — clearer
   intent, no coupling.
4. **Component coverage for the runs-filters island.** Added
   `runs-filter-bar.test.tsx` covering `RunsSearchInput` — the smallest
   piece that exercises the debounced URL round-trip via `navigate()`.
5. **CI visual-baseline opt-in wiring.** `test-e2e-ui` now passes
   `WRIGHTFUL_VISUAL_BASELINE_OK` from a repo variable. Inert today
   (no committed Linux PNGs yet); flipping `vars.VISUAL_BASELINE_OK=1`
   in repo settings — after a maintainer commits Linux baselines —
   activates `visual.spec` without a code change.
6. **Drive-by typecheck cleanup**: typed the `res.json()` body in the
   new `run-test-preview.handler.test.ts` so my files stay clean. (Two
   pre-existing failures remain in `run-progress-broadcast.test.ts`
   and reporter `shutdown.test.ts` — out of scope.)

## Why

The recent Playwright commit chain (`477a819` POMs, `e014b03` role
locators, `0edbaa9` xpath removal, `93c86b8` happy-dom swap) had
already tightened the suite considerably. The remaining issues were
structural rather than correctness-level: serial-only execution
hiding behind an undocumented session-coupling, oversized test files,
fake timers used as a blanket setting, and one component-level gap
where Playwright was the only safety net for a pure client-side
state round-trip.

## Files changed

| File                                                                   | Why                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/e2e/playwright.dashboard.config.ts`                          | `workers: process.env.CI ? 3 : undefined` (was `1`) + comment on parallel-safety preconditions                                   |
| `packages/e2e/tests-dashboard/logout.spec.ts`                          | Mints a throwaway session via `/api/auth/sign-in/email` for the primary user; sign-out invalidates only that one                 |
| `packages/dashboard/src/__tests__/route-handlers.test.ts`              | Deleted                                                                                                                          |
| `packages/dashboard/src/__tests__/user-state.handler.test.ts`          | New — `setLast{Team,Project}` 401/400/404                                                                                        |
| `packages/dashboard/src/__tests__/test-result-summary.handler.test.ts` | New — project-scope SQL assertions + private cache header                                                                        |
| `packages/dashboard/src/__tests__/run-test-preview.handler.test.ts`    | New — 4-bucket SELECTs scoped to project + committed runs                                                                        |
| `packages/dashboard/src/__tests__/team-suggestions.handler.test.ts`    | New — join (with GitHub-org gate), dismiss, undismiss; case-insensitive org match; same-origin redirect rule                     |
| `packages/reporter/src/__tests__/client.test.ts`                       | `useFakeTimersForRetries()` helper applied only inside `retries` and `network errors` describes; non-retry tests use real timers |
| `packages/dashboard/src/__tests__/components/runs-filter-bar.test.tsx` | New — debounced URL write, filter-preservation, page reset, no-op on equal value                                                 |
| `.github/workflows/ci.yml`                                             | `WRIGHTFUL_VISUAL_BASELINE_OK: ${{ vars.VISUAL_BASELINE_OK }}` on the dashboard UI e2e job                                       |

## Logout fix detail (the one non-mechanical change)

The shared-session blocker was easy to miss. `tests-dashboard/global-setup.ts`
writes a single `storageState.json` derived from sign-up cookies, and
every worker reads the same file. Better Auth's sign-out endpoint
deletes the _current_ session row server-side. With `workers > 1`,
the moment any worker hits sign-out, every other worker holding that
same session cookie starts getting 401s.

The fix: in `logout.spec`, drop the shared storageState
(`test.use({ storageState: { cookies: [], origins: [] } })`),
`POST /api/auth/sign-in/email` with the primary user's credentials to
mint a fresh session row, inject those cookies into the test's
context, then run the UI logout flow. Better Auth stores each
sign-in as its own row; signing out invalidates only the row this
test created. Other workers' sessions are unaffected.

## Verification

| Check                                               | Result                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm test` (dashboard unit + components, reporter) | 335 + 109 = 444 tests pass                                                                                     |
| `pnpm format`                                       | clean                                                                                                          |
| `pnpm lint`                                         | 0 errors (40 pre-existing warnings)                                                                            |
| `pnpm --filter @wrightful/dashboard typecheck`      | only pre-existing `run-progress-broadcast.test.ts` errors remain                                               |
| `pnpm --filter @wrightful/reporter typecheck`       | only pre-existing `shutdown.test.ts` error remains                                                             |
| Playwright UI suite                                 | not run locally (requires booted dashboard); user to verify with `pnpm --filter @wrightful/e2e test:dashboard` |

## Follow-ups (deferred, not blocking)

- Generate Linux PNG baselines for `visual.spec` and flip
  `vars.VISUAL_BASELINE_OK=1` in repo settings to activate the
  visual-regression check in CI.
- Address pre-existing typecheck failures in
  `run-progress-broadcast.test.ts` and `shutdown.test.ts` — separate
  task, unrelated to this review.
- The `color-contrast` axe rule remains suppressed in `a11y.spec`;
  TODO already inline. Tracked separately because the fix is
  design-token rebalancing across light + dark modes, not a test
  change.
