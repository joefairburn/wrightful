# 2026-04-19 — Runs list: clickable failure/flaky badges open a popover

## What changed

On the runs list (`/t/:teamSlug/p/:projectSlug`), the failed and flaky test-count badges are now interactive. Clicking either badge opens a popover listing the first 5 matching test results with a link to the full run report. Data is fetched lazily via TanStack Query, with a prefetch on pointer-enter / focus, so the runs list itself doesn't carry any extra DB load — the fetch only fires when a user actually engages with a row.

## Details

| File                                                             | Change                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/package.json`                                | Added `@tanstack/react-query`.                                                                                                                                                                                                                                                                                                         |
| `packages/dashboard/src/app/components/query-provider.tsx`       | **New.** `"use client"` wrapper around `QueryClientProvider`. One `QueryClient` per client mount (via `useState` initialiser). Defaults: `staleTime: 15_000`, `refetchOnWindowFocus: false`. Mounted inside `AppLayout` (per rwsdk's Chakra-style provider pattern) so the Query context reaches every page rendered under the layout. |
| `packages/dashboard/src/app/components/app-layout.tsx`           | Wrapped the layout JSX in `<QueryProvider>` so any descendant client component on any app route can use TanStack Query hooks.                                                                                                                                                                                                          |
| `packages/dashboard/src/routes/api/run-failures.ts`              | **New.** `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/failures` handler. Returns up to 5 `failed` (status `failed`/`timedout`) + 5 `flaky` results plus totals.                                                                                                                                                                    |
| `packages/dashboard/src/worker.tsx`                              | Mounted the new route before `prefix("/api", …)` so it sits under Better Auth session middleware (`loadSession`, `requireUser`), not the CLI bearer-token chain.                                                                                                                                                                       |
| `packages/dashboard/src/app/components/run-failures-popover.tsx` | **New.** Client island wrapping the existing `Popover` primitive. Prefetches on `onPointerEnter`/`onFocus`, fires `useQuery` on open, renders a skeleton / error / list / empty UI.                                                                                                                                                    |
| `packages/dashboard/src/app/pages/runs-list.tsx`                 | Replaced the failed + flaky `<span>` badges with `<RunFailuresPopover>`. Removed now-unused `X` and `TriangleAlert` imports.                                                                                                                                                                                                           |

## Fetch strategy

Lazy-on-open + hover-prefetch, rather than pre-fetching failures for every visible row on the server.

- The runs list can show up to 50 rows. Most rows have zero failures; pre-fetching universally would ship a pile of empty slices.
- Hover-prefetch typically populates the query cache before the click, so the popover opens with data already in place.
- `enabled: isOpen` on the `useQuery` means the fetch only actually runs when the popover opens — a pure hover never wastes a fetch beyond the prefetch itself, and the 15s `staleTime` deduplicates rapid hover+click.

## Endpoint contract

```
GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/failures

200 →
{
  failed: Array<{ id, title, file, projectName, status, errorMessage }>,  // ≤ 5
  flaky:  Array<{ id, title, file, projectName, status, errorMessage }>,  // ≤ 5
  failedTotal: number,
  flakyTotal: number
}
Cache-Control: private, max-age=15
```

Tenancy: `resolveProjectBySlugs(userId, teamSlug, projectSlug)` enforces membership; the underlying Drizzle query joins `testResults` → `runs` and filters on `runs.projectId = project.id` in addition to `runs.id = runId`, so `testResults.runId` is never trusted on its own. 401 for unauthenticated; 404 for unknown/non-member team or project (don't leak existence).

## Notes

- The popover reuses the `Popover` / `PopoverTrigger` / `PopoverPopup` wrappers in `src/app/components/ui/popover.tsx`. Keyboard semantics (Enter to open, Esc to close, focus return) come from Base UI for free.
- The trigger inherits its Tailwind classes from the prior badge so the visual remains identical until interacted with; hover/focus add a subtle background shift and a ring.
- Each failure in the list links to `/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:id`, reusing the existing test-detail route. The footer "View full report" link points at the run detail page.
- The shared `FailureItem` / `FailuresResponse` types are defined in the server handler and imported from the client component via `import type`, so they carry zero runtime weight into the client bundle.

## Verification

- `pnpm typecheck` — clean (cli + dashboard under tsgo).
- `pnpm --filter @wrightful/dashboard test` — 55/55 pass (vitest).
- `pnpm lint` — 0 errors, 3 pre-existing warnings (the `requestInfo.params` assertion pattern in `active-project.ts`, `route-params.ts`, `app-layout.tsx`). No new warnings.
- `oxfmt --check` on the five touched files — all formatted.
- Manual dev-server walkthrough pending.

## Follow-up: extended to all four badge variants (passed + skipped)

After the first pass shipped, the popover was extended from failed/flaky to cover **all four badges** (passed, failed, flaky, skipped) for UX consistency — the user said every badge should do the same thing even though passed/skipped are lower-signal than failed/flaky.

### Renames

- `run-failures.ts` → `run-test-preview.ts`; handler `runFailuresHandler` → `runTestPreviewHandler`; types `FailureItem`/`FailuresResponse` → `TestPreviewItem`/`TestPreviewResponse`.
- `run-failures-popover.tsx` → `run-tests-popover.tsx`; export `RunFailuresPopover` → `RunTestsPopover`.
- Route path `/runs/:runId/failures` → `/runs/:runId/test-preview`.

### Endpoint contract

```
GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview
{ failed: Item[≤5], flaky: Item[≤5], passed: Item[≤5], skipped: Item[≤5] }
```

Totals (formerly `failedTotal` / `flakyTotal`) are removed — the client already has them on the `runs` row via `run.passed` / `run.failed` / `run.flaky` / `run.skipped`, so echoing them was redundant.

### Query strategy change

The previous implementation fetched every failed/flaky test for the run and sliced to 5 in JS. That worked for failures (small N) but doesn't scale to passed, where a run can easily have hundreds of passes. Rewrote as four parallel Drizzle queries, each `WHERE status IN (…) LIMIT 5`, run via `Promise.all`. Tenancy enforced on every sub-query via the `runs.projectId = project.id` predicate.

### Component

- `Variant` extended to `"failed" | "flaky" | "passed" | "skipped"`.
- Badge trigger classes for passed (`bg-success/8` + `Check`) and skipped (`bg-muted` + `Minus`) match the previously-static spans with added `hover:` / `focus-visible:` affordances so they feel interactive.
- `errorMessage` rendering remains guarded to `variant === "failed"` only.

### runs-list.tsx

All four `<span>` badges in the test-counts cell are now `<RunTestsPopover>` instances. `Check` and `Minus` imports moved with them; the page file only imports icons it uses directly (`GitBranch`, `GitCommit`, `GitPullRequest`).

### Verification (follow-up)

- `pnpm typecheck`, `pnpm lint`, `pnpm --filter @wrightful/dashboard test` — all green (still 3 pre-existing warnings).
- Manual browser smoke test still pending on the second pass.
