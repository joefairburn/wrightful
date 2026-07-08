# 2026-07-08 — Embedded self-hosted Test Replay + e2e dashboard isolation guard

## What changed

Ported the "embedded Test Replay" feature (self-hosted Playwright Trace Viewer)
and the e2e isolation guard from an upstream fork's PR
(`gitasf/bumper-playwright-dashboard#3`) into this tree. The fork is a mirror of
this codebase, so most of the change applied 1:1; one piece — the per-row "Test
Replay" button in the run's Tests tab — was **re-plumbed** against our current
architecture, which had diverged from the fork's base (see "Adaptation" below).

Three things landed together:

1. **Embedded Test Replay.** We vendor Playwright's official Trace Viewer bundle
   into `public/trace-viewer/` and serve + iframe it from our OWN origin, so
   time-travel debugging (command log, DOM-snapshot scrubber, network/console)
   happens on the dashboard instead of bouncing users — and their trace bytes —
   out to the public `trace.playwright.dev`. Surfaced two ways: the test-detail
   **artifacts rail** button (relabelled "Trace Viewer" → "Test Replay"), and a
   **per-row** button in the run's test list.
2. **E2E dashboard isolation guard + CI.** A guarded `test:dashboard` wrapper
   that can never point `void db reset` at your dev DB, plus a dedicated
   `wrightful_e2e` CI database.
3. **Realtime nav-guard** (bundled bug fix). A WS reconnect landing mid-SPA-nav
   no longer bounces the user back to the page they're leaving.

No schema, ingest, or wire-contract changes — Test Replay is purely a serving +
UI change on top of `trace` artifacts the reporter already captures into R2.

## Details

| Area              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendoring         | New `apps/dashboard/scripts/vendor-trace-viewer.mjs` copies the trace-viewer bundle out of `playwright-core/lib/vite/traceViewer` into `public/trace-viewer/`, pinned to the installed version (currently **1.61.1**), idempotent (version stamp), fails loudly if the source layout moves. Wired into `predev`/`prebuild`/`predeploy` and into `bootDashboard` (the e2e harness spawns `vp dev` directly, bypassing the npm pre-hook). Output dir gitignored. |
| Serving / CSP     | `void.json` gains a path-scoped `/trace-viewer/*` headers block (`X-Frame-Options: SAMEORIGIN`, `Service-Worker-Allowed`, a relaxed `frame-ancestors 'self'` CSP with `unsafe-eval`/`worker-src blob:`). Void's last-match-wins merge scopes the relaxation to that path only; the strict global `/*` CSP (`frame-ancestors 'none'`, `DENY`) is unchanged for every other route.                                                                               |
| URL builder       | `signedTraceViewerUrl()` now returns `/trace-viewer/index.html?trace=<absolute signed download URL>` (self-hosted) instead of the `trace.playwright.dev` wrap. New `TRACE_VIEWER_PATH` constant. `traceViewerUrlFor()` (the public-viewer wrap) is kept for the direct-R2 path.                                                                                                                                                                                |
| Dialog UI         | New `src/components/trace-viewer-dialog.tsx` — a near-full-viewport `Dialog` whose iframe mounts only while open (defers the ~1.6 MB bundle to first use). `TraceViewerDialog` (rail, URL known) + `TestReplayButton` (list, URL fetched lazily). Color tokens aligned to our app conventions (`border-line-1`/`text-fg-3`/`bg-bg-0`).                                                                                                                         |
| Rail              | `RailTraceButton` swapped from an external `<a target="_blank">` to the embedded dialog and relabelled "Test Replay". The standalone **Video**/**Screenshot** rail buttons are **kept** (handy for grabbing one asset without the whole trace.zip).                                                                                                                                                                                                            |
| Lazy replay route | New session-authed `GET /api/t/:team/p/:project/runs/:runId/tests/:testResultId/replay` — mints a fresh signed viewer URL + download href for the test's last-attempt trace, 404 when none. Applied verbatim from the fork; every dependency (`childByTestResultWhere`, `resolveTenantApiScope`) matched.                                                                                                                                                      |
| Nav-guard         | `use-feed-room.ts` skips the reconnect `router.refresh()` while a navigation is in flight (`useNavigation().state !== "idle"`, read through a ref). Correct standalone fix; applied verbatim.                                                                                                                                                                                                                                                                  |
| E2E guard         | New `packages/e2e/scripts/run-dashboard-e2e.mjs`; `test:dashboard` runs it (raw escape hatch = `test:dashboard:raw`). Resolves an e2e `DATABASE_URL` that can never be the dev DB (suffixes `_e2e`), auto-creates it, and refuses to run if a `pnpm dev` server is up on `:5173` (probes IPv4 + IPv6). Overrides: `E2E_DATABASE_URL`, `E2E_ALLOW_DEV_SERVER`.                                                                                                  |
| CI                | `.github/workflows/ci.yml` `test-e2e-dashboard` job renamed its throwaway DB `wrightful_test` → `wrightful_e2e` (the postgres service already existed).                                                                                                                                                                                                                                                                                                        |

## Adaptation — per-row button against our re-architected Tests tab

The fork gated the per-row button on `tracedTestIds`, **computed in the SSR
run-detail loader** over SSR-seeded test rows. Our tree no longer works that way:
`runs/[runId]/index.server.ts` doesn't load tests at all, and `RunProgress` pages
groups/rows client-side via TanStack `useInfiniteQuery`
(`run-progress.tsx` → `run-progress-group.tsx` → `run-progress-row.tsx`). So the
fork's loader/`index.tsx`/`run-progress.tsx` hunks had no anchors and were
**dropped**. Instead:

- `RunProgressTest` gains an **optional** `hasTrace?: boolean` (wire type; the
  live broadcast path leaves it `undefined`, so a live-streamed row gets the
  button only after its group re-fetches — matching the fork's documented
  "appears after reload" behaviour, since traces upload post-completion anyway).
- The `GET …/results` route attaches `hasTrace` per row via one batched
  `selectDistinct` over the page's ids (`type='trace'`, project-scoped). Confined
  to that route, so the shared `loadRunResultsPage` and the v1 / CSV / MCP
  surfaces that reuse it are untouched.
- `run-progress-row.tsx`'s `TestRow` unwraps its single `<Link>` into a `<div>`
  with the nav link + `TestReplayButton` (gated on `test.hasTrace`) + an
  `aria-hidden` chevron as siblings. On a completed run (the replay use case)
  `byId` is empty (rooms don't replay events), so `mergeGroupRows` keeps the
  server rows and `hasTrace` survives — no change needed to the hot merge path.

## Deliberately not ported

- The fork's three worklogs (internally contradictory — e.g. they claim the
  Video/Screenshot buttons were "dropped" and CI "gained a postgres service",
  neither true in the actual diff) — replaced by this single entry.
- `docs/integrations/wrightful-reporter.md` — tailored to the fork's private
  frontend repo (12-project matrix, `NEXT_PUBLIC_ENV`, its branch names); not
  generic enough for this OSS repo.
- The `DATABASE_URL` fixture passthrough (already present here).

## Self-hosting note

`void.json` `routing.headers` only apply on the managed `void deploy` path, not
own-account `deploy:cf`/wrangler (see `public/_headers`). The embed still works
on own-account (no global `DENY` to fight there), it just lacks the defense-in-
depth headers. Mirroring `/trace-viewer/*` into `public/_headers` for parity is
a possible follow-up, kept generic per the OSS/self-hosting stance.

## Verification

- **Vendoring:** `vendor-trace-viewer.mjs` vendored playwright-core 1.61.1
  (index.html / sw.bundle.js / snapshot.html present), re-run reported "up to
  date", output gitignored. ✓
- **Typecheck:** `void prepare && tsgo --noEmit` → 0 errors (the typed client
  resolves the new `/replay` route; `hasTrace` typing clean). ✓
- **Unit:** dashboard node lane 281 passed / 4 skipped; workers lane 1219 passed;
  `artifact-tokens.workers` (self-hosted URL shape, 9) + `use-feed-room` /
  `use-room-reseed` (nav-guard, 16) all green. ✓
- **Static:** `pnpm check` → **0 errors**, 130 warnings (all pre-existing
  `no-unsafe-type-assertion` baseline in `packages/e2e`; my files add none). ✓
- **Dashboard Playwright e2e (`test-replay.spec.ts`): NOT run locally.** The new
  guard correctly refused (a `pnpm dev` server was live on `::1:5173`); running
  it would have needed `E2E_ALLOW_DEV_SERVER=1`, which risks the dev session it
  exists to protect. CI's `test-e2e-dashboard` job (now on `wrightful_e2e`) will
  exercise it. Logic traced as compatible: terminal runs auto-expand failing
  groups, so traced rows render and the per-row button appears without manual
  expansion.

## Follow-ups (not in this change)

- Run headless verification of the in-browser DOM-snapshot scrub on a real trace.
- Optionally mirror `/trace-viewer/*` headers into `public/_headers` for
  own-account deploy parity.
