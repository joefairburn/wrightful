# 2026-06-09 — Dashboard frontend review fixes (realtime reseed/reconnect, pagination SPA links, token/markup cleanups)

## What changed

Implemented the verified-review fix batch for the dashboard frontend. The two
load-bearing changes are in the realtime layer:

1. **Room hooks now reseed across same-component SPA navigations.** Void
   renders page components unkeyed, so navigating run A → run B (history-strip
   links) or changing runs-list filters re-rendered the same mounted component
   with fresh loader props while `useRunRoom` / `useProjectRoom` kept the
   previous page's `useState` seed. Both hooks now track their seed identity
   (`runId`/`projectId` + the seed-prop references) and reset live state during
   render when it changes (React's "adjusting state when props change"
   pattern). Loader props get fresh object identities per navigation, so
   reference comparison is the key. Constraint documented on the hook: seed
   props must be referentially stable across re-renders — the run-detail page
   now memoizes its derived `initialSummary` on the `run` loader prop.

2. **Reconnect reconciliation.** Rooms have no event replay, so a viewer
   disconnected across a run's terminal broadcast used to reconnect to silence
   and show "running" forever. `subscribeToRoom` / `useRoom` now expose an
   `onReconnect` hook point (fires on socket RE-open, never the first open).
   `useRunRoom` re-fetches the session-authed run summary
   (`/api/t/:teamSlug/p/:projectSlug/runs/:runId/summary`, slugs threaded in
   from the run-detail page through `RunSummaryLive` / `RunStatusGlyphLive` /
   `RunDurationLive` / `RunTestCountLive` / `RunProgress`) and folds the
   snapshot through the existing reducer as an empty-`changedTests` progress
   event; in-flight fetches are aborted on newer reconnects and unmount.
   `useProjectRoom` calls `router.refresh()` so the loader re-runs and the
   reseed picks the fresh rows up.

## Details

| Fix                         | Files                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reseed + reconnect          | `src/realtime/use-room.ts`, `use-run-room.ts`, `use-project-room.ts`; slug threading in `src/components/run-{summary,detail}-live.tsx`, `run-progress.tsx`, `pages/.../runs/[runId]/index.tsx`                                                                                                                                                  |
| Pagination SPA links        | `src/components/ui/pagination.tsx` (buttonVariants now apply under `render` too), `src/components/table-pagination-footer.tsx` (`render={<Link/>}` for prev/next/pages; disabled prev/next keep the plain `<a>`)                                                                                                                                |
| `*-foreground` token misuse | `run-history-bar-hover.tsx` (count chips + StatusChip → `text-success/destructive/warning`), `run-tests-popover.tsx` (`text-destructive/80`), `insights/slowest-tests.tsx` (`p95Text`)                                                                                                                                                          |
| Hardcoded colors            | EnvPill production tone → `var(--fail-soft)`/`var(--fail)`; `insights/run-duration.tsx` p90/p95 → `var(--flaky)`/`var(--fail)`                                                                                                                                                                                                                  |
| Pill consolidation          | New `src/components/run-meta-pills.tsx` (Branch/Pr/Env/Commit pills; params: BranchPill `className` max-width, CommitPill `marker="dot"\|"icon"`; stopPropagation always on). Run detail now uses shared `branchUrl`/`commitUrl` from `src/lib/pr-url.ts` — restores GitLab branch/commit links there; local duplicates + stale comment deleted |
| Loader waterfalls           | `insights/slowest-tests.server.ts` (branches ∥ totals, histogram ∥ bottlenecks), `insights/suite-size.server.ts` (all 6 queries in one `Promise.all`), `flaky.server.ts` (branches ∥ aggregate)                                                                                                                                                 |
| suite-size branch filter    | tests-added (recent set branch-scoped via `branchJoinFragment`/`branchFragment`; NOT EXISTS first-seen check stays project-wide), file + tag distributions (conditional `innerJoin(runs)` + `eq(runs.branch)` via `$dynamic()`)                                                                                                                 |
| SWR cache headers           | `insights/slowest-tests.server.ts`, `tests.server.ts` now send `private, max-age=300, stale-while-revalidate=900` like the sibling insights loaders                                                                                                                                                                                             |
| Dead code                   | Deleted `src/components/duration-chart.tsx`, `error-page.tsx`, `not-found.tsx` (zero refs); deleted `groupTestsByFile` + `buildDescribeTree` + their interfaces/private helpers from `src/lib/group-tests-by-file.ts` and their test blocks (live exports + tests kept)                                                                         |
| monitor-form                | Cancel → `<Link>` via ui `Button render`; Run-once/submit → ui `Button`; local FieldLabel re-skins ui `Label`                                                                                                                                                                                                                                   |
| flaky-test-row              | raw `<td>` → ui `TableCell` (matches run-list-row)                                                                                                                                                                                                                                                                                              |
| SegmentedControl            | `aria-pressed` on segment buttons (attempt-tabs pattern)                                                                                                                                                                                                                                                                                        |
| Copy-feedback timeouts      | New `src/lib/use-copied-flag.ts` (ref-tracked timer, cleared on re-click + unmount); used by `artifacts-rail.tsx` (TerminalBlock, CopyArtifactButton) + `artifact-actions.tsx` (CopyPromptButton)                                                                                                                                               |
| Avatar hue                  | New `src/lib/avatar-hue.ts`; used by `actor-avatar.tsx` + workspace-switcher `TeamBadge` (deleted local `teamHue`)                                                                                                                                                                                                                              |
| run-progress auto-expand    | Latch fires on first render when seeded non-empty (as before); when seeded empty (live run) it waits for the first failed/flaky-bucket test instead of latching on the first all-passing group                                                                                                                                                  |

## Tests

- New: `src/__tests__/use-room-reseed.test.ts` (renderHook + mocked `void/ws`
  / `void/client` / `@void/react`: stable-identity preservation, runId-change
  reseed, reference-change reseed, reconnect summary fetch + fold, slug-less
  skip, post-unmount abort; project-room reseed + `router.refresh`).
- Extended: `src/__tests__/use-room-sharing.test.ts` (reconnect fires on
  re-open only; fan-out to all registered reconnect listeners; fake socket now
  discriminates message/open handlers).
- New (#17): `pr-url.test.ts` (github-actions/gitlab-ci/unknown across
  pr/commit/branch + encoding), `time-format.test.ts`, `page-window.test.ts`
  (ellipsis windowing edges), `links.test.ts` (substitution, encoding,
  throw-on-missing-param).

## Verification

- `pnpm --filter @wrightful/dashboard exec tsgo --noEmit` (after `void
prepare`): clean.
- `vp lint` over all touched files: 0 errors (2 pre-existing warnings in
  untouched files).
- Full dashboard suite: 751 passed, 2 failed — both failures are in
  `artifacts-pipeline.test.ts` and `scope-where.test.ts`, pinned to
  `src/lib/artifacts.ts` / `src/lib/runs-filters-where.ts` which were being
  edited concurrently by other agents (those files were explicitly out of
  scope for this batch).
