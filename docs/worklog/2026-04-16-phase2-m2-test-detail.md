# 2026-04-16 — Phase 2 (M2): Test detail page + artifact download

## What changed

Phase 2 Milestone 2 — uploaded artifacts are now viewable in the dashboard. Clicking a row on a run page opens a new test-detail page showing error output, tags, annotations, and downloadable artifacts. Trace `.zip` artifacts get a one-click "Open in Playwright Trace Viewer" link that hands off to `trace.playwright.dev` with a short-lived presigned R2 URL.

Two discrete pieces:

1. **Test detail page** at `/runs/:runId/tests/:testResultId` — an RSC page that queries D1 directly for the test result, its retries, tags, annotations, and artifacts in parallel, then renders a focused debugging view.
2. **Artifact download endpoint** at `GET /api/artifacts/:id/download` — unauthenticated route (unguessable ulid is the auth for v1) that looks up the `r2Key`, signs a 10-minute GET URL via the `r2-presign` helper shared with M1, and 302-redirects.

## Design decisions

- **Unauthenticated GET.** The download endpoint is wired _outside_ the `/api` prefix-auth chain so `trace.playwright.dev` can follow it without any Authorization header. The ulid (128 bits of entropy) is the only thing gating access. An explicit `TODO(phase5)` in [artifact-download.ts](../../packages/dashboard/src/routes/api/artifact-download.ts) points at moving to a signed-token challenge once we have a path that doesn't break trace-viewer integration.
- **Trace viewer is a link-out.** No iframe embed. `trace.playwright.dev` doesn't document iframe support and likely sends `X-Frame-Options: DENY`. A self-hosted trace viewer is tracked as a Phase 5 item — the comment in [test-detail.tsx](../../packages/dashboard/src/app/pages/test-detail.tsx) makes that explicit so future readers aren't tempted to work around the link-out.
- **Single join query for ownership.** The data loader issues one inner-join (`testResults` ⨝ `runs`) keyed by both `runId` and `testResultId`, so visiting `/runs/A/tests/B` where B belongs to a different run returns 404 instead of leaking data. Tags/annotations/artifacts then fan out in a single `Promise.all`.
- **No new chart components yet.** Tags and annotations render as inline chips with existing inline-style utilities. A shared component library is still intentionally deferred — will fall out naturally when M3 (test history) lands and adds sparklines.

## Files

- **new** [packages/dashboard/src/app/pages/test-detail.tsx](../../packages/dashboard/src/app/pages/test-detail.tsx)
- **new** [packages/dashboard/src/routes/api/artifact-download.ts](../../packages/dashboard/src/routes/api/artifact-download.ts)
- **new** [packages/dashboard/src/\_\_tests\_\_/artifact-download.test.ts](../../packages/dashboard/src/__tests__/artifact-download.test.ts) — 3 tests (404, 302, missing creds)
- mod [packages/dashboard/src/worker.tsx](../../packages/dashboard/src/worker.tsx) — adds `/runs/:runId/tests/:testResultId` route and unauthenticated `/api/artifacts/:id/download` route
- mod [packages/dashboard/src/app/pages/run-detail.tsx](../../packages/dashboard/src/app/pages/run-detail.tsx) — each test row is now a link to the detail page

## Verification

- `pnpm typecheck` — clean.
- `npx oxlint` — 0 errors, 6 warnings (all `no-unsafe-type-assertion` on intentional `env` / `fetch` boundary casts).
- `npx oxfmt --check .` — clean.
- `pnpm --filter @wrightful/dashboard test` — 37 tests passing (was 34 after M1, +3 in the download handler suite).
- `pnpm --filter @wrightful/cli test` — 83 tests (unchanged — M2 is dashboard-only).

Manual end-to-end verification deliberately deferred until M3, when the "View history" cross-link (already present on the detail page) will have a target page to open.

## What's next

M3 — test history page. The "View history for this test" link on the detail page already points at `/tests/:testId`; that page doesn't exist yet and will 404 until M3 ships.
