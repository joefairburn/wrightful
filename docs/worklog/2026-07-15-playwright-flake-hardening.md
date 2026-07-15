# Playwright flake hardening

## Why

Wrightful's 30-day history for the `wrightful/wrightful` main branch reported
10 flaky dashboard tests. The failures clustered around unrelated navigation,
auth, monitor, API-key, and group flows rather than one product area.

Trace and error-context inspection showed three recurring causes:

- two Playwright workers saturated the single shared Void server and database;
- actions raced React/Void hydration, so clicks could be discarded or native
  form behavior could run instead of the client mutation;
- retry blocks repeated side effects or accepted stale UI as success.

## What changed

- The canonical dashboard suite briefly moved to one worker while the races
  below were fixed; parallel workers were then re-enabled — see
  "Parallel workers" below. CI retries remain enabled so Wrightful can still
  identify a genuine first-attempt failure.
- The app shell exposes a single `data-app-hydrated` marker. Because
  `useHydrated` is a global signal and `AppLayout` wraps every project/settings
  route, that one attribute proves the whole page (shell and content) is
  interactive — so page objects wait on it (via `waitForHydration`) rather than
  sprinkling per-form/per-list hydration attributes through product code. They
  then perform each mutation or navigation click once.
- Shared navigation waits for the exact URL, a page-specific landmark, and app
  hydration without waiting for every subresource's `load` event.
- API-key minting, duplicate-group creation, run/test navigation, and monitor
  creation/editing now wait for explicit user-visible outcomes instead of
  retrying clicks.
- Slow password hashing, dev-trigger requests, monitor scheduling, and trace
  parsing have bounded operation-appropriate timeout budgets.
- The API-key reveal dialog now has semantic title/description elements. The
  run-history chart's labelled, non-clickable current point now has an image
  role, fixing the serious axe violation exposed by the full serial suite.
- Axe failures now include the offending selector and HTML in their error.

## Parallel workers (follow-up, 2026-07-16)

With the hydration and retry races fixed, the suite was re-parallelised
(`workers: 2` in CI, `4` locally; `fullyParallel` stays `false` so tests
within a file keep their order). Three things had to change first:

- **The real blocker was a dev-server module race, not test isolation.**
  With 4 workers on a cold `vp dev`, the first concurrent burst of authed-page
  SSR renders raced the workerd module runner on the shared
  `void/client` → `src/lib/auth-client.ts` import chain. One render observed a
  half-initialized namespace (`TypeError: createAuthClient is not a
function`), the runner cached the poisoned module, and every later page
  render 500'd for the life of the process (~29/52 tests failed; only routes
  not importing that chain kept passing). Serial runs never trigger it, which
  is why one worker looked like the only safe configuration. `global-setup.ts`
  now warms the SSR module graph serially — one cookie-authenticated GET per
  page family, failing fast on 500 — before any worker starts. Add new page
  families to that list. Postgres was ruled out empirically (< 20 connections
  throughout).
- **"Newest run" readers are pinned to the seeded failures branch.**
  `realtime.spec` and `monitors.spec` legitimately create runs in the shared
  project mid-suite, and the runs list live-inserts rows via the project WS
  room. `openSeededRun` now defaults to `FAILURES_BRANCH` (monitor stub runs
  carry `branch: null` and realtime branches are unique-per-test, so nothing
  else can match), and navigation's row-click test filters the same way. All
  other specs already isolated their writes (timestamped names, per-pid
  tenants, throwaway sessions).
- **The Replay workbench test recovers from its own load watchdog.** Under a
  busy dev server the workbench's 30s no-progress watchdog
  (`BRIDGE_TIMEOUT_MS`) can fire before queued SW/trace fetches complete — a
  terminal "Couldn't load this trace" state. The test closes and reopens the
  dialog (a pure read) up to twice instead of failing on contention.

Diagnostics: `WRIGHTFUL_E2E_SERVER_LOG=<path>` tees the booted dev server's
output to disk (`src/dashboard-fixture.ts`); without it the buffered log is
lost unless the server exits mid-run.

Suite wall-clock dropped from ~4 minutes to ~2 at 4 workers.

## Verification

- `pnpm check`
- 54 interaction/auth/group/navigation/test-detail checks passed across three
  repetitions.
- 8 monitor alert/synthetic/uptime checks passed across two repetitions.
- 12 accessibility/trace-replay checks passed across two repetitions.
- Full canonical dashboard suite serially: 51 passed, 1 skipped, 0 failed.
- Full canonical dashboard suite at 4 workers: three consecutive runs
  (51+50+51 passed) with the only failure being the pre-recovery Replay
  workbench watchdog, plus two more green runs after adding the recovery.
