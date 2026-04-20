# 2026-04-19 — group artifacts by attempt on test-detail

## What changed

A failed test with N retries was producing (N+1) × M artifacts with identical
names, rendered as one flat list on the test-detail page. Users couldn't tell
which trace/video/screenshot belonged to which attempt.

Plumbed Playwright's `result.retry` through the reporter → wire schema → D1
→ UI, then grouped the test-detail artifact list into "Attempt N" sections
with a deterministic per-attempt type ordering (trace, video, screenshot,
other).

## Details

### Reporter

- `packages/reporter/src/index.ts` — added `attempt: number` to
  `PreparedArtifact`; `collectArtifacts` now pushes `attempt: result.retry`
  for each attachment (the outer loop already iterates
  `entry.results` in attempt order); `fireArtifactUploads` includes
  `attempt` in each `ArtifactRegistration`.
- `packages/reporter/src/types.ts` — `ArtifactRegistration.attempt: number`.

### Wire schema

- `packages/dashboard/src/routes/api/schemas.ts` — `ArtifactRequestSchema`
  now includes `attempt: z.number().int().min(0).default(0)`. The default
  keeps older reporters compatible: a payload without `attempt` parses as
  `0` (initial attempt).

### Database

- `packages/dashboard/src/db/schema.ts` — `artifacts.attempt integer NOT
NULL DEFAULT 0`.
- `packages/dashboard/drizzle/0000_*.sql` — regenerated in place via
  `db:generate` (pre-launch squash policy, per `CLAUDE.md` + feedback
  memory). Migration renamed to `0000_huge_spacker_dave.sql` as a side
  effect of regeneration.
- The regenerated migration dropped the `committed_runs` view that drizzle
  v0.31 doesn't round-trip reliably for SQLite views — appended the same
  `CREATE VIEW` statement that was in the prior migration by hand.

### Register endpoint

- `packages/dashboard/src/routes/api/artifacts.ts`:
  - Persists `attempt` on insert.
  - Chunks the insert to stay under D1's 100-bound-parameter cap. Before
    this change the artifacts table was 8 columns wide and a 12-row batch
    (3 attempts × 4 attachments for a failed test with 2 retries) landed
    at 96 params — just under the cap. Adding `attempt` took it to 108
    params and the whole register call started 500ing with `too many SQL
variables`, which surfaced in the dashboard as "No artifacts were
    uploaded for this test." The fix mirrors the `chunkByParams` pattern
    already used for `test_results` in `runs.ts`: chunk rows into
    `floor(99 / 9) = 11` per statement.
  - Chunks the `inArray(testResults.id, requestedIds)` validation SELECT
    by 99 ids. Today's reporter batches ≤20 tests per register call so
    we'd never hit the cap in practice, but the endpoint previously had
    no server-side cap on payload size and a misconfigured or future
    client could send enough distinct testResultIds to trip it.

### Runs-list filter parsing

- `packages/dashboard/src/lib/runs-filters.ts` — `readList` now slices
  to `MAX_FILTER_VALUES = 50`. Each entry becomes a bound param via
  `inArray(committedRuns.branch|actor|environment, …)` in
  `buildRunsWhere`; without a cap, any authenticated team member could
  craft a URL like `?branch=a,b,…` with 100+ values and 500 the runs
  list. 50 is well under D1's 99-param budget with headroom for the
  query's other conditions.

### UI

- `packages/dashboard/src/app/pages/test-detail.tsx`:
  - Selects `attempt`, orders by `asc(artifacts.attempt)`.
  - Groups artifacts by attempt into sections, each headed `Attempt N`
    with a suffix label derived from the test's `retryCount`:
    `initial` (attempt 0), `retry N` (intermediate), `final attempt`
    (last attempt).
  - Within each group, orders by a fixed type priority (trace → video
    → screenshot → other), then name.
  - Per-attempt rendering delegated to a new client island
    `ArtifactActions`. The server still mints signed download hrefs and
    the trace-viewer URL and passes them down as props — the client
    never mints tokens.
- `packages/dashboard/src/app/components/artifact-actions.tsx` (new,
  `"use client"`) — Cypress-style compact action-button row. Icons from
  lucide-react:
  - **Play video** (`Play`) → opens a dialog with `<video controls
autoPlay>`.
  - **View screenshot** (`ImageIcon`) → opens a dialog with a full-size
    `<img>`.
  - **Open trace** (`History`) → external link to
    `https://trace.playwright.dev/?trace=…` (unchanged behavior).
  - **Copy prompt** (`Copy` → `CopyCheck`) → `fetch`es the
    `error-context.md` body and writes it to the clipboard; icon flips
    to `CopyCheck` for 1.5s as feedback. Playwright's error-context.md
    is already structured as a markdown LLM prompt (Instructions, Test
    info, Error details, Page snapshot, Test source), so the label
    matches the intent.

### Attempts & errors accordion

Rather than render a separate top-of-page error Alert and a loose list of
attempt sections, the page now uses a single **Attempts & errors**
accordion (base-ui `Accordion` via `ui/accordion.tsx`) per Cypress's
layout (see `.context/attachments/image-v3.png`):

- One `AccordionItem` per attempt, ordered newest-first.
- The latest attempt is open by default; older attempts collapse.
- Each trigger shows a status icon (`CheckCircle2` / `XCircle` /
  `MinusCircle`), the attempt number, the attempt label, and a tiny
  artifact count.
- The panel contains the error `Alert` (attached to the one attempt the
  reporter sourced the error from — last attempt for `failed` /
  `timedout`, first attempt for `flaky`, none otherwise) and the
  `ArtifactActions` row.

Per-attempt status is derived client-free in
`test-detail.tsx:attemptStatus` from `result.status` + `attempt` +
`totalAttempts` — no wire changes needed.

## Tests

- `packages/dashboard/src/__tests__/schemas.test.ts` — added three cases:
  `attempt` defaults to 0 when omitted, accepts non-negative integers,
  rejects negatives.
- `packages/dashboard/src/__tests__/artifacts.test.ts` — extended the happy
  path to send `attempt: 2` and assert it lands in the inserted row.

## Verification

- `pnpm typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 90 pass, 1 pre-existing
  failure (`run-detail-scoping.test.ts` stack overflow — unrelated, also
  fails on `main`).
- `pnpm --filter @wrightful/reporter test` — 20 / 20 pass.
- `pnpm lint` — 9 pre-existing warnings, 0 errors.
- `pnpm format` — clean after `format:fix`.
- End-to-end path: because the migration was regenerated in place, local
  devs need to wipe D1 before the next `setup:local` — the existing view
  canary in `setup-local.mjs` will also trigger a wipe if a dev's DB
  still has the old `0000_misty_miss_america` tag. After wiping,
  `pnpm setup:local` + `pnpm dev` seeds the fixture suite (which enables
  `retain-on-failure` trace/video + 2 retries in
  `packages/dashboard/fixtures/playwright/playwright.config.ts`) and the
  test-detail page renders three "Attempt N" sections for the seeded
  failed-with-retries test.
