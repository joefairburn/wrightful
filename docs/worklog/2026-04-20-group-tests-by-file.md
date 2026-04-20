# 2026-04-20 — Group run test results by test file (Cypress-style)

## What changed

The run detail page previously rendered a flat list of test results, sorted by status, with each row prefixing its title with the source file path. On larger suites this was hard to scan — you had to read each row's `file ›` prefix to mentally group related tests together. Cypress solves this by grouping tests under a file-name header with per-file metadata; we now do the same.

Tests are grouped by their `file` path and rendered inside a collapsible accordion, one item per file. All groups are expanded by default. Each group's header shows the file basename, directory prefix, per-status counts (failed / timedout / flaky / passed / skipped / queued), total duration, and the unique Playwright project names (`chromium`, `firefox`, …) that ran tests in that file.

## Details

Client-side only rendering change. The realtime wire type (`RunProgress` in `packages/dashboard/src/routes/api/progress.ts`) is unchanged — grouping is derived from `progress.tests` at render time inside a `useMemo`. The streaming ingest path, the realtime broadcast, the Durable Object, and the D1 schema are all untouched.

| File                                                                 | Change                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard/src/lib/group-tests-by-file.ts` (new)            | `groupTestsByFile(tests)` + `FileGroup` type. Pure; aggregates per-file counts, duration sum, unique sorted `projectNames`, and a `worstStatus` used for group sort. Tests with a missing `file` bucket into a trailing "Other" group.                                                           |
| `packages/dashboard/src/app/components/run-progress.tsx`             | `RunProgressTests` rewritten to render groups via `Accordion` / `AccordionItem` / `AccordionPanel`. New `FileGroupHeader` + `GroupCount` subcomponents. `TestRow` no longer prefixes the title with the file (group header carries it).                                                          |
| `packages/dashboard/src/__tests__/group-tests-by-file.test.ts` (new) | 11 unit tests covering empty input, single/multi-file, missing-file bucketing, path splitting, duration summation, per-status counts, `worstStatus` severity ordering, group sort (severity then path), "Other" always last, unique sorted `projectNames`, preserved input order within a group. |

### Group sort order (worst first)

`failed` → `timedout` → `flaky` → `queued` → `skipped` → `passed`, with ties broken by file path. The "Other" bucket is always placed last regardless of its worst status (it's a diagnostic bucket, not a primary sort target).

### Queued handling during streaming

Queued tests stay inside their file's group — Playwright announces the full set of test files at `onBegin`, so `file` is populated on every row even before a test has run. The accordion keeps its open/closed state across realtime pushes since `useSyncedState` only mutates the `progress` prop and `defaultValue` is memoised against `groups`.

### Why a separate lib file

`run-progress.tsx` is a `"use client"` module. Extracting the pure aggregator into `lib/group-tests-by-file.ts` keeps the unit test free of React/lucide/base-ui imports and follows the `lib/runs-filters.ts` precedent.

## Describe-block hierarchy inside each file

After the initial file-level grouping, tests whose titles encode Playwright describe blocks (`file > DescribeA > DescribeB > test title`) landed at the same level as the file accordion row — no visual hierarchy between a describe group and a bare top-level test. Fixed by rendering a nested describe tree inside each file's accordion panel.

- **New in `packages/dashboard/src/lib/group-tests-by-file.ts`:**
  - `parseTitleSegments(title, file, projectName)` — strips the leading `projectName` and `file`-basename segments that Playwright's `titlePath()` bakes into the stored `title` (see reporter's `buildTestDescriptor`). Returns `{ describeChain, testTitle }`.
  - `buildDescribeTree(tests, file)` — builds a `DescribeNode[]` tree where branches are describe-block names and leaves are tests. Siblings preserve first-seen order.
- **`packages/dashboard/src/app/components/run-progress.tsx`:**
  - New `flattenDescribeTree` walks the tree into an ordered `RenderRow[]` (describe header rows + test rows tagged with depth), which keeps the JSX a flat `<ul>` with simple keys and avoids deeply nested DOM.
  - New `DescribeHeaderRow` — a muted, non-collapsible divider with a small right-chevron icon and the describe name.
  - `TestRow` now accepts `displayTitle` (just the leaf test name, no `file >` or describe prefix) and `depth`; left padding is computed as `20 + depth * 18 px`.
  - The error-details block under a failed row indents with the row, so the error stays visually attached to its test at any depth.
- **Tests added (total 24):** `parseTitleSegments` — no-prefix / file-only / projectName+file / deep nesting / no-false-positive on coincidental basename substring. `buildDescribeTree` — empty, no-describe leaf, single describe, mixed siblings, deep nesting, first-seen order preservation.

Kept the describe layer **non-collapsible** for this iteration (Cypress makes nested describes collapsible; we don't yet). Only the file layer uses the accordion.

## Error colour rendering + artifact links in the run detail view

The error block under each failing test on the run detail view rendered `errorMessage` as plain `<pre>` text — so ANSI escapes (`[31m` et al) leaked through as literal characters and the errors looked nothing like the test detail page. The decorative chevron on non-collapsible describe rows was also pruned (it implied interactivity that wasn't there).

### Shared error component

- **New:** `packages/dashboard/src/app/components/test-error-alert.tsx` — `TestErrorAlert` — single source of truth for Playwright error rendering. Uses `Alert variant="error"`, runs `errorMessage`'s first line through `ansiToHtml` into the `AlertTitle`, and optionally renders `errorStack` as an ANSI-coloured `<pre>` in the `AlertDescription`. A `children` slot positions action buttons in the top-right (replaces both the ad-hoc copy-prompt positioning on the test detail page and the lack of action buttons on the run detail page).
- **Migrated:** `packages/dashboard/src/app/pages/test-detail.tsx` now uses `TestErrorAlert` (dropping its inline `Alert` + `ansiToHtml` wiring).
- **Migrated:** `packages/dashboard/src/app/components/run-progress.tsx` now uses `TestErrorAlert` inside `TestRow`, replacing the plain `<pre>{errorMessage}</pre>` block.

### errorStack in the progress wire type

The `RunProgress` snapshot didn't carry `errorStack`, so inline errors were text-only. Added `errorStack: string | null` to `RunProgressTest` (`packages/dashboard/src/routes/api/progress.ts`) and selected it in `composeRunProgress`. Only failing / flaky rows carry a non-null stack, so the extra bytes on the realtime WebSocket broadcast are negligible.

### Artifact action links on failing rows

- **New server helper:** `packages/dashboard/src/lib/test-artifact-actions.ts`
  - `errorAttempt(finalStatus, totalAttempts)` — moved from the private helper inside `test-detail.tsx` (now shared).
  - `traceViewerUrl(origin, id, token)` — moved from `test-detail.tsx`.
  - `toArtifactAction(row, origin, token)` — artifact row → `ArtifactAction`.
  - `loadFailingArtifactActions(failingTests, origin)` — one indexed SELECT over `artifacts` (using `artifacts_test_result_id_idx`) for all failing test ids, groups by test, picks the attempt that carries the error (per `errorAttempt`), filters to media types (`trace`, `video`, `screenshot` — `other` is reserved for copy-prompt and doesn't belong in the inline action row), signs per-artifact tokens with `signArtifactToken`, and returns a `Record<testResultId, ArtifactAction[]>`.
- **Run detail page:** `packages/dashboard/src/app/pages/run-detail.tsx` now calls `loadFailingArtifactActions` alongside `composeRunProgress` and passes the map down to `RunProgressTests` / `RunTestsIsland`.
- **Run progress component:** `RunProgressTests` takes an optional `artifactActionsByTestId` prop and hands the right slice to each failing `TestRow`, which renders `<ArtifactActions>` (existing component — buttons: `Open trace`, `Play video`, `View screenshot`) inside the `TestErrorAlert`'s action slot.

Note: during a live-streaming run, tests that transition from queued → failed _after_ SSR won't get artifact actions inline — the realtime `RunProgress` payload doesn't include them. The failing row still links through to the test detail page, which loads artifacts on demand. Treating this as an acceptable MVP trade-off; the more correct fix (broadcast artifact metadata on `register-artifact` ingest) is a larger change best deferred until the failure mode is observed.

### Describe header chevron removed

`DescribeHeaderRow` no longer renders a `ChevronRight`. Describe rows are non-collapsible — the chevron implied interactivity that wasn't there. Header now shows only the indented describe name.

## Clickable summary tiles filter the test list

The four summary tiles at the top of the run detail page (Total / Passed / Failed / Flaky) are now buttons. Clicking one filters the test list below; clicking the active tile (or the Total tile) clears. Filter state is URL-synced via `nuqs` (`?status=passed|failed|flaky`) so the view is shareable and survives reloads — consistent with the runs-list filter-bar pattern.

- **`packages/dashboard/src/app/components/run-progress.tsx`:**
  - New `useStatusFilter()` hook wrapping `useQueryState("status", parseAsStringLiteral(["passed","failed","flaky"]))`.
  - New `matchesFilter(status, filter)` pure helper — `failed` bucket includes `timedout` (same semantics as `counts.failed` on the run row).
  - `SummaryTile` is now a `<button>` with `aria-pressed`, `hover:bg-muted/30`, `focus-visible:ring`, and an `isActive` state that adds `bg-muted/40 ring-2 ring-ring/30`.
  - `RunProgressSummary` reads + writes the filter; each tile's `onClick` toggles (setting to null when already active; Total always clears).
  - `RunProgressTests` reads the filter, applies `matchesFilter` before sorting + grouping, shows `visibleTests of totalTests` in the card header when a filter is active, plus a clearable chip (filter name × ) next to "Test Results". Empty filter states get a specific message ("No failing tests in this run.", etc).
- **nuqs**: `NuqsAdapter` was already mounted globally (`packages/dashboard/src/app/providers.tsx`); this is the first actual consumer. Works in both the streaming island (`RunTestsIsland`) and the static render path because `RunProgressSummary` / `RunProgressTests` live in the same `"use client"` module and both call the same hook, so URL state auto-syncs between them.
- **Why nuqs here, not rwsdk `navigate`**: the runs-list filter bar uses rwsdk's `navigate` because filter changes require a server refetch; here the entire test list is already in memory from the progress snapshot, so we just need client-side URL state — `nuqs` is the lighter fit and matches the CLAUDE.md guidance.

## Correction: custom nuqs adapter for rwsdk

The previous section claimed nuqs "works in both the streaming island and the static render path" — it didn't. `NuqsAdapter` from `nuqs/adapters/react` is a **browser-only SPA adapter** and throws `[nuqs] nuqs requires an adapter to work with your framework` during rwsdk's SSR pass (caught only once a real server render hit the filter hook). rwsdk is not in nuqs's official adapter list (Next / Remix / React Router / TanStack / testing / React SPA).

Fix: wrote a custom adapter using `unstable_createAdapterProvider` from `nuqs/adapters/custom`.

- **New:** `packages/dashboard/src/lib/nuqs-rwsdk-adapter.tsx` — implements `useAdapter(watchKeys): AdapterInterface`.
  - `searchParams` on SSR: read from a `ServerSearchContext` that the RSC `Document` populates with the request URL's search string.
  - `searchParams` on CSR: `useSyncExternalStore` over `window.location.search`, subscribed to a module-level listener `Set` + a single `popstate` handler. Both `RunProgressSummary` and `RunProgressTests` subscribe independently and re-render together when either writes the URL.
  - `updateUrl(next, { history, shallow, scroll })`:
    - `shallow: true` (default) → `window.history.replaceState` / `pushState`, then `csrNotify()` so all subscribers re-render. No RSC refetch. Right for in-memory filter UI.
    - `shallow: false` → `navigate(url, { history })` from `rwsdk/client`. Routes through rwsdk's navigation, triggers RSC re-render. Matches the runs-list filter-bar pattern for cases where the server has to re-query.
    - `scroll: true` → `window.scrollTo(0, 0)`.
- **`packages/dashboard/src/app/components/app-layout.tsx`** — mounts `<NuqsRwsdkAdapter serverSearch={url.search}>` around `<QueryProvider>`. AppLayout is a server component (async) and already reads `requestInfo`, so it's the right place to pass the server-side URL down to the client-side adapter.
- **Removed:** `packages/dashboard/src/app/providers.tsx`. The initial attempt mounted the adapter in `document.tsx` via `Providers`, but rwsdk's Document is a separate render tree from the page tree — client-side React context mounted in Document doesn't propagate to the page subtree during SSR (the first error's component stack showed `QueryProvider → AppLayout` with no `Providers` ancestor, confirming it). Moving the adapter into `AppLayout` alongside `QueryProvider` puts it in the actual page render tree and fixes SSR. `document.tsx` reverted to its previous shape (no prop plumbing).

No changes to `run-progress.tsx` — `useStatusFilter` / `useQueryState` / `parseAsStringLiteral` are untouched and now resolve against the rwsdk adapter.

### Why not ditch nuqs for a hand-rolled hook

Considered — a `useSyncExternalStore` + `history.replaceState` hook would have been ~25 lines. But nuqs is already a dependency and gives us parsing / validation / serialisation primitives the project will want when filter state grows beyond one enum (e.g. adding a file filter or a "show flaky only" toggle alongside status). The adapter is ~60 lines and unlocks idiomatic `useQueryState` everywhere in the app.

## Test detail: attempts as tabs

Replaced the per-attempt accordion on the test detail page with a tab bar. Previously you had to click to expand each attempt; now the final attempt's state (what most users want first) is visible on load, and every attempt is one keystroke away.

- `packages/dashboard/src/app/pages/test-detail.tsx`:
  - Swapped the `<Accordion multiple>` block for `<Tabs defaultValue={String(totalAttempts - 1)}>` using the existing `Tabs` / `TabsList` / `TabsTab` / `TabsPanel` wrappers (Base UI). `variant="underline"` keeps the tab bar low-chrome.
  - Iteration order flipped: chronological (`0 … N-1`) so tabs read left-to-right as a timeline. The previous newest-first order made sense for an accordion expanding downward; tabs want the opposite.
  - Default tab is the **final** attempt. For failed/timedout tests that's where the error lives anyway; for flaky tests it's the passing attempt, with earlier failing attempts one click away.
  - New `AttemptStatusDot` helper — a 1.5×1.5 coloured dot, replacing the 4×4 `AttemptStatusIcon` for a more compact tab header. Old icon helper + `CheckCircle2 / XCircle / MinusCircle / ChevronDown` / `Accordion*` imports dropped.
  - Per-panel content unchanged in shape: `TestErrorAlert` (with ANSI-coloured title + stack) plus `ArtifactActions` + optional `CopyPromptButton` slotted into the alert's action area. For attempts without an error, `ArtifactActions` renders above a muted "No error details recorded" line.

No data-loading / schema / routing / realtime changes. Other pages (run detail, run list) untouched.

## Test detail: split view with folder tabs + sticky rail

Shaped the test detail page to match the prototype (`image-v12.png` + the accompanying HTML sketch): full-width split view, folder-style tabs in a left-pane header bar, permanent sticky rail on the right.

### Page-level layout

Dropped the `max-w-6xl p-6 sm:p-8` centering wrapper. Page is now `h-full flex flex-col`:

1. **Top context bar** — back link + `view test history` link, status badge, leaf test title, `file · project · duration · retries`, tag/annotation badges. Single thin row, not a vertical stack of sections.
2. **Split view** (`flex-1 min-h-0 flex`):
   - Left column (`flex-[3] min-w-0 flex flex-col border-r`): header (title + status) + folder-tab strip + scrollable body with the error Alert for the active attempt.
   - Right column (`w-[320px] shrink-0 overflow-y-auto`): `ArtifactsRail`.

Each column has its own `overflow-auto`, so they scroll independently inside the dashboard's main content area. No `position: sticky` — independent overflow is enough, and cleaner.

### Tabs wrap the whole split

Both the `TabsList` (in the left header) and the per-attempt `TabsPanel`s (in both columns) sit inside one `<Tabs>` context. Each attempt has **two** `TabsPanel`s with the same `value` — one in the left column carrying the error, one in the right column carrying its artifacts/reproduction/environment. Base UI handles multiple panels keyed to the same tab without fuss; this avoids having to lift tab state into React state + pass it through multiple refs.

### Folder-style tabs

Kept the existing `TabsList variant="underline"` / `TabsTab` primitives; folder look is a className override on each `TabsTab`:

```tsx
"h-auto rounded-none rounded-t-md border-x border-t border-transparent";
"px-4 py-2 font-mono text-xs";
"-mb-px"; // tab sits on top of the border
"data-active:bg-background data-active:border-border"; // active tab matches body bg
"data-active:text-foreground";
```

The active tab's background matches the body (`bg-background`), so it reads as a folder connected to the content below. Base UI's `TabsPrimitive.Indicator` still renders the coloured underline tracking the active tab. No new `tabs.tsx` variant added — the styling is local to this page.

### `ArtifactsRail` (new)

`packages/dashboard/src/app/components/artifacts-rail.tsx` — three optional sections:

- **Artifacts**: vertical full-width buttons for trace (external `<a>` to `trace.playwright.dev`), video (`Dialog` + `<video>`), and screenshot (`Dialog` + `<img>`). Each button is `Button size="sm" variant="outline" className="w-full justify-between"` with an `ArrowRight` on the right.
- **Reproduction**: terminal-styled block rendering `npx playwright test <file> --grep <leaf>` (both quoted via `JSON.stringify` so paths/titles with quotes are safe), with a copy icon in the block's header. If the run also uploaded an `other`-type copy-prompt artifact, a "Copy prompt" button appears under the terminal.
- **Environment**: two-column key/value grid. Fields rendered only when present: `Browser` (← `testResults.projectName`), `Worker` (← `testResults.workerIndex`), `Playwright` (← `runs.playwrightVersion`). OS / viewport are not rendered — we don't store them yet, and the section header is hidden entirely when the grid would be empty.

Buttons are reimplemented locally (~30 lines of duplication vs. `ArtifactActions`). The shared `ArtifactActions` stays horizontal-only by preference; no `orientation` prop was added. Run-detail keeps using it as-is.

### Reproduce command

Derived in the RSC with `parseTitleSegments(result.title, result.file, result.projectName)` (already in `packages/dashboard/src/lib/group-tests-by-file.ts` from the file-grouping work). `testTitle` is the leaf segment after stripping any projectName + file prefix + describe chain — exactly what you'd pass to Playwright's `--grep`.

### Fallout

- `ArtifactActions` / `CopyPromptButton` imports removed from `test-detail.tsx`; the previously broken `orientation="vertical"` calls are gone.
- The rounded `bg-card` container around the attempts section is gone — it's a flat split view now.
- `TestErrorAlert`'s `children` slot isn't used from this page anymore; run-detail still uses it for its inline action buttons.

## Per-attempt error storage

Before this change, the reporter aggregated Playwright's `results: TestResult[]` down to a single `errorMessage`/`errorStack` on each `test_results` row. Every other attempt's error got dropped on the floor — so the test-detail attempt tabs were forced to show "No error details recorded for this attempt" for every attempt except the one that "carried" the aggregate (last for failed/timedout, first for flaky, via a heuristic).

End-to-end fix:

- **New table** `test_result_attempts` (`packages/dashboard/src/db/schema.ts`): one row per Playwright attempt, FK to `test_results(id)` with `ON DELETE CASCADE`. Columns: `attempt`, `status` ("passed"|"failed"|"timedout"|"skipped"), `durationMs`, `errorMessage`, `errorStack`, `createdAt`. Indexed on `testResultId`; unique on `(testResultId, attempt)`.
- **Squashed migration**: deleted the in-progress `0000_huge_spacker_dave.sql` and re-ran `pnpm db:generate` per CLAUDE.md's pre-launch convention. Single new migration now covers the full schema.
- **Wire types** (`packages/reporter/src/types.ts`, `packages/dashboard/src/routes/api/schemas.ts`): `TestAttemptPayload` + `attempts: TestAttemptPayload[]` on `TestResultPayload`. Zod schema requires `attempts` with `min(1)` — Playwright always runs at least once.
- **Reporter** (`packages/reporter/src/index.ts`): `buildPayload` now maps `results` to `attempts[]`, one entry per retry. A `normaliseAttemptStatus` helper folds `"timedOut"` → `"timedout"` (wire enum) and treats `"interrupted"` as `"skipped"` rather than inventing a new enum value. Aggregate `errorMessage`/`errorStack`/`retryCount` on `test_results` are **kept** — still used by the runs list rollups, the run-detail inline error preview, and `loadFailingArtifactActions`.
- **Ingest** (`packages/dashboard/src/routes/api/runs.ts`): after upserting `test_results`, `buildResultInsertStatements` pushes a `DELETE FROM test_result_attempts WHERE testResultId = ?` and then one INSERT per `attempts[]` entry. Delete-then-insert keeps the handler idempotent when the reporter re-flushes (e.g. on retry) without needing the conflict-target dance.
- **Test detail** (`packages/dashboard/src/app/pages/test-detail.tsx`): added a fourth parallel query for `testResultAttempts`, resolves each tab's status + error from the stored row via a local `resolveAttemptView` helper. The old `errorAttempt()` and inferred-`attemptStatus()` heuristics are replaced; a tiny fallback path still handles rows with no `test_result_attempts` data (dev DBs only — no production data pre-launch).

### Out of scope (confirmed and unchanged)

- `RunProgressTests` on the run-detail page still reads `errorMessage`/`errorStack` off the aggregate (`RunProgress` wire type). Inline preview; no per-attempt need.
- `composeRunProgress` + the realtime broadcast: unchanged. No per-attempt data on the streaming channel.
- `lib/test-artifact-actions.ts`'s `errorAttempt(finalStatus, totalAttempts)` still picks the artifact-carrying attempt for the run-detail error block. Aggregate path, no per-attempt dependency.

## Verification

- `pnpm --filter @wrightful/reporter test` — 23/23 pass (added three cases in `aggregation.test.ts` covering per-attempt errors across 1, 3-failing, and flaky patterns).
- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/schemas.test.ts` — new `attempts[]` cases pass (missing rejected, empty rejected, multi-attempt accepted, invalid status rejected, negative index rejected).
- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/group-tests-by-file.test.ts` — 24/24 pass.
- `pnpm --filter @wrightful/dashboard test` — 118/119 pass. The one failure (`run-detail-scoping.test.ts` — `Maximum call stack size exceeded` in drizzle's alias proxy) reproduces on the pristine tree before any changes in this workstream, so it's pre-existing and unrelated.
- `pnpm typecheck` — clean.
- `pnpm lint` — 9 pre-existing warnings in `packages/reporter/src/client.ts`; no new warnings or errors introduced.
- Manual UI walkthrough pending (user runs `pnpm dev`):
  - Open a run detail page with no query param — no SSR crash; Total tile active; all tests render.
  - Open the URL with `?status=failed` directly — SSR renders filtered; no hydration flash; Failed tile highlighted.
  - Click each tile — URL gains `?status=…` via `replaceState`, list narrows, chip appears. Clicking the active tile or Total clears.
  - Browser back/forward across a few filter toggles — `popstate` updates the UI cleanly.
  - The error block should still render with red ANSI colours + artifact buttons (Open trace / Play video / View screenshot) from the previous iteration.
