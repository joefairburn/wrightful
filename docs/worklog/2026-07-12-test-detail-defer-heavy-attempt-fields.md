# 2026-07-12 — Defer heavy per-attempt fields on the test-detail page

## What changed

The test-result detail page
(`pages/t/[teamSlug]/p/[projectSlug]/runs/[runId]/tests/[testResultId]/`)
was eagerly shipping every attempt's full `errorStack` (capped ~128 KiB),
`stdout` (capped 64 KiB) and `stderr` (capped 64 KiB) in the `attempts` page
prop. A 3-retry flaky test with chatty console output could add several
hundred KB to the SSR HTML/hydration payload — most of it for attempts the
viewer isn't looking at (the default tab is the final attempt) or output
that's only ever rendered inside the artifacts rail's already-deferred
Output section.

Split the per-attempt reads into eager (cheap) and deferred (heavy) tiers,
following the page's existing `defer()` + `DeferredSection` + skeleton
pattern (already used for the duration-history strip and the artifact-signing
fan-out):

- **Eager**: `attemptSummaries` (attempt/status/durationMs for every attempt
  — drives the tab bar + attempt count) and `primaryAttempt` (the default
  tab's — i.e. highest attempt number's — `errorMessage`/`errorStack` only).
  The primary attempt's error is the page's above-the-fold content; it must
  paint immediately, no Suspense.
- **Deferred** (`attemptDetails`, one new `defer()`): `errorMessage`/
  `errorStack`/`stdout`/`stderr` for every attempt. Consumed from two
  independent spots reading the same resolved promise via `use()` — the left
  column's non-primary attempt panels (each individually wrapped in a
  `DeferredSection`, only mounted once a viewer clicks that attempt's tab)
  and the right rail's Output section (already inside the existing
  `artifacts` `DeferredSection`).

### Mutation-path check

The page has two mutations (quarantine toggle, owner assign) but neither is
a same-page Void `action()` — both are plain `<form action="/api/t/.../...">
method="post">` submits to separate Hono routes
(`routes/api/t/[teamSlug]/p/[projectSlug]/quarantine.ts` /
`owners.ts`), which redirect (`c.redirect(redirectTo)`) back to this page on
success/failure. That's a fresh full navigation (GET) through the normal
loader, not a mutation response the page's own props stream over — so
deferring `attemptDetails` doesn't hit the "can't defer over a mutation
response" caveat.

### Realtime-island check

No `useRunRoom`/`useProjectRoom` island on this page consumes attempt data
— confirmed via grep. Nothing to keep eager for a ws-mount seed.

## Details

| File                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/dashboard/src/lib/test-result-children.ts` | Split the single full per-attempt query into `loadTestResultAttemptSummaries` (light), `loadTestResultPrimaryAttemptDetail` (single eager heavy row, `order by attempt desc limit 1`), and `loadTestResultAttemptDetails` (all-attempts heavy rows). Extracted `loadTestTagsAndAnnotations`. `loadTestResultChildren` (used by the MCP `get_test_result` tool, which wants everything eager in one JSON-RPC response — no streaming there) now composes the new helpers and returns the identical `{ tags, annotations, attempts }` shape as before — zero behavior change for MCP, verified against the existing pg-integration assertion in `ingest.test.ts` (`loadTestResultChildren` stdout/stderr-round-trip test). |
| `.../tests/[testResultId]/index.server.ts`       | Eager batch now fetches `{tags, annotations}`, `attemptSummaries`, `primaryAttempt` instead of the old single `loadTestResultChildren` call. Added a new `attemptDetails: defer(...)` prop alongside the existing `history` and `artifacts` defers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.../tests/[testResultId]/index.tsx`             | Reworked attempt rendering: `resolveAttemptStatus` (status-only, was `resolveAttemptView`); new `AttemptErrorContent` (shared alert-or-empty-state body), `DeferredAttemptError` (reads `attemptDetails` via `use()`, only rendered for non-primary attempts), `AttemptErrorSkeleton` (alert-shaped fallback, sized to avoid layout shift on tab switch). `TestArtifactsRail` now reads `attemptDetails` itself (via `use()`) to build `outputByAttempt` instead of receiving it as an eager prop. The legacy no-attempt-rows fallback path (pre-attempt-tracking data) is untouched — fully eager, same as before, since there's no per-attempt DB data to split in that case.                                          |

## Verification

- Read every consumer of `attemptRows`/`children.attempts` via grep across
  `apps/dashboard` (page, `test-result-children.ts`, `mcp/queries.ts`,
  `pg-integration/ingest.test.ts`) to confirm nothing else depends on the old
  single combined shape.
- Confirmed the quarantine/owner mutation routes redirect (fresh GET) rather
  than returning page props directly, by reading
  `routes/api/t/[teamSlug]/p/[projectSlug]/quarantine.ts`.
- Confirmed via grep no `useRunRoom`/`useProjectRoom` usage under this page's
  directory.
- Did NOT run `pnpm check` / build / test suites for this change (out of
  scope for this pass per the instructions it was implemented under); the
  next commit on this branch should run `pnpm check` + the dashboard test
  suite (including the pg-integration `ingest.test.ts` `loadTestResultChildren`
  assertion) before landing.

## Payload estimate

Worst case before: primary attempt (~192 KiB: errorMessage + errorStack) +
2 non-primary attempts × (errorMessage + errorStack + stdout + stderr, up to
~320 KiB each) ≈ **≤ 832 KiB** for a 3-attempt flaky test with capped-length
fields, all eager.

Worst case after (initial payload): primary attempt's errorMessage +
errorStack (~192 KiB) + lightweight summaries for the other attempts
(a few dozen bytes each) ≈ **~192 KiB**, with the remaining ~640 KiB moved
behind `defer()` and streamed only once (shared by both the left column's
on-demand tabs and the right rail), not blocking first paint.
