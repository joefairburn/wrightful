# 2026-04-19 — Runs list: filters + search

## What changed

Added a filter bar to the runs list page (`/t/:teamSlug/p/:projectSlug`). Users can now narrow the view by Status, Branch, Actor, Environment, and Date Range, plus a free-text search over commit message, SHA, and branch. Filter state lives in URL search params so views are shareable and survive reloads/back-forward navigation.

## Details

- New: `packages/dashboard/src/lib/runs-filters.ts` — `parseRunsFilters`, `toSearchParams`, `hasAnyFilter`, `buildRunsWhere`. Builds a Drizzle `and(...)` over `committedRuns` (the read-side view) with `eq`, `inArray`, `gte`, `lte`, `like`, `or`. LIKE patterns are escaped so user-typed `%` / `_` match literally.
- New: `packages/dashboard/src/app/components/runs-filter-bar.tsx` — client island. Debounced search input (300ms); Base UI `Combobox` (multi-select, `items` + `value`/`onValueChange`) for Status, Branch, Actor, Environment — each anchored to a filter-button trigger, with built-in keyboard nav and text-filter input inside the popup; `Popover` + range `Calendar` for dates. Commits changes to the URL via `navigate(..., { history: "replace" })` from `rwsdk/client` so rwsdk's client navigation triggers an RSC refetch — chose this over nuqs because the nuqs adapter uses `history.pushState` directly and wouldn't fire rwsdk's navigation handler.
- Modified: `packages/dashboard/src/app/pages/runs-list.tsx` — reads `requestInfo.request.url`, parses filters, applies them in the main query, loads distinct branch/actor/environment option lists in parallel (`selectDistinct` scoped to the project), and renders the filter bar to the right of the "All Runs" title. Counter pill now reads "N match" when filters are active and "N total" otherwise.

### URL param shape

| Param    | Example                   | Notes                                        |
| -------- | ------------------------- | -------------------------------------------- |
| `q`      | `q=login`                 | matches commit msg, SHA, branch (LIKE `%q%`) |
| `status` | `status=failed,flaky`     | restricted to the 6 known run statuses       |
| `branch` | `branch=main,release/1.0` |                                              |
| `actor`  | `actor=alice,bob`         |                                              |
| `env`    | `env=production`          |                                              |
| `from`   | `from=2026-04-01`         | inclusive, day start UTC                     |
| `to`     | `to=2026-04-15`           | inclusive, day end UTC                       |

### Query scoping

Every filtered read still anchors on `eq(committedRuns.projectId, project.id)` as the first condition — tenant isolation preserved per CLAUDE.md.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm lint` — no new warnings or errors from this change (5 pre-existing warnings unchanged).
- `pnpm --filter @wrightful/dashboard test` — 66/67 pass; the 1 failure (`run-detail-scoping.test.ts`) is pre-existing on `main` (stack overflow in test setup, unrelated).
- `pnpm format:fix` applied.
- Manual UI walkthrough pending (planned: exercise each filter individually, combine filters, reload to confirm persistence, share URL to confirm replay, Clear-all, empty-state when filters exclude all rows).

## Follow-up — review fixes + `date-fns` adoption

Code review surfaced two real bugs in the filter bar and an open question about adopting `date-fns` project-wide. Both bugs fixed; `date-fns` adopted in the dashboard at every formatting / parsing / validation site.

### Bug fixes

- **Stale-closure race in search debounce** (`runs-filter-bar.tsx`). The 300 ms `useEffect` only depended on `[qLocal]`, so its pending timer fired with the `filters` / `pathname` captured at setup — selecting any other filter (status/branch/actor/env/date) within 300 ms of a keystroke would be clobbered when the debounce flushed. Fixed with a `latestRef` that mirrors `{ pathname, filters }` every render; the timer callback reads from the ref, so the flush always uses the freshest state. Also added `filters.q` to the dep list so `qDirtyRef` clears promptly after URL round-trip.
- **`isValidIsoDate` accepts invalid calendar dates** (`runs-filters.ts`). `Date.parse("2026-02-30")` succeeds in V8 and rolls to Mar 2 — malformed URL params silently shifted meaning. Replaced with `isValid(parse(s, "yyyy-MM-dd", new Date()))` from `date-fns` behind the existing shape regex. Verified: `2026-02-30`, `2026-13-01`, `2025-02-29` (non-leap) are now all rejected.

### `date-fns` adoption

Added `date-fns` to `@wrightful/dashboard` (not the CLI). Migrated sites:

| File                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/runs-filters.ts`                 | `isValidIsoDate` uses `isValid`/`parse`; from/to bounds use `parseISO` with the existing UTC suffix (preserves day-boundary semantics — `startOfDay`/`endOfDay` use local time and would drift off workers that ever run outside UTC).                                                                                                                                                                    |
| `app/components/runs-filter-bar.tsx`  | `toIsoDate` → `format(d, "yyyy-MM-dd")`; `formatDate` renamed to `formatDisplayDate` and uses `format(parseISO(...), "dd/MM/yy")`; range `useMemo` uses `parseISO`.                                                                                                                                                                                                                                       |
| `lib/time-format.ts`                  | `formatRelativeTime` internals use `differenceInMinutes/Hours/Days`. Output contract preserved (`just now` / `5m ago` / `3h ago` / `2d ago`) — `date-fns`' `formatDistanceToNowStrict` would produce the verbose `"5 minutes ago"` form and widen every run row, test-history tooltip, and sparkline label. `formatDuration` left untouched — no clean `date-fns` analogue for sub-second compact output. |
| `app/pages/settings/project-keys.tsx` | `toISOString().slice(0, 10)` → `format(d, "yyyy-MM-dd")` for Created / Last used columns.                                                                                                                                                                                                                                                                                                                 |
| `app/components/ui/calendar.tsx`      | `formatMonthDropdown` uses `format(d, "MMM")` instead of `date.toLocaleString("default", { month: "short" })`.                                                                                                                                                                                                                                                                                            |

Out of scope: `new Date()` used to stamp DB rows (ingest, user-state, auth, team/project create, key create/revoke, `$onUpdate`) and `Date.now()` arithmetic for token/cookie expiries (`artifact-tokens.ts`, `sidebar.tsx`). Those aren't formatting — they're idiomatic and correct.

### `@tanstack/pacer` — considered and declined

For the one debounced surface, a `latestRef` fix is ~5 LoC and equally correct. Revisit if a second debounced surface (global search, command palette, etc.) appears.

### Tests

New `src/__tests__/runs-filters.test.ts` covers: `isValidIsoDate` (incl. the Feb-30 regression, non-leap Feb-29, loose `yyyy-M-d` shape), `parseRunsFilters` (status whitelist, comma lists, `q` trimming, date dropping), `hasAnyFilter`, and a smoke-test on `buildRunsWhere`. 10 tests, all passing.

## Follow-up — debounce cleanup (same day)

The `latestRef` + `qDirtyRef` approach from the previous follow-up fixed the stale-closure bug but left behind three refs, a render-time ref assignment, and an `eslint-disable` covering both the outgoing write and the inbound URL sync. Splitting those two concerns collapses the whole thing.

### Changes

- **New:** `packages/dashboard/src/lib/hooks/use-debounced-value.ts` — 10-line generic `useDebouncedValue<T>(value, delay)` built on `setTimeout` + cleanup. SSR-safe (initial render returns the input value).
- **Modified:** `packages/dashboard/src/app/components/runs-filter-bar.tsx` — `RunsSearchInput` now uses `useDebouncedValue(qLocal, 300)` and two small effects:
  1. `[debouncedQ]` → commit to URL when `debouncedQ !== filters.q`.
  2. `[filters.q]` → reconcile local state when the user isn't mid-edit (`qLocal === debouncedQ`).
     The stale-closure hazard is gone because each render produces a fresh effect closure over the current `pathname`/`filters`; we deliberately pin the commit effect to `[debouncedQ]` (with a narrow `eslint-disable-next-line` + rationale) so unrelated URL-state churn doesn't re-fire a write. `latestRef`, `qDirtyRef`, and the render-time ref write are all deleted. `useRef` dropped from imports.

### `@tanstack/pacer` — still declined

Same conclusion as before, re-confirmed now that the hand-rolled code is 10 lines instead of ~20. One debounced surface in the dashboard doesn't justify a dependency. Revisit if/when a second rate-limited interaction appears (async-cancel debounce, leading-edge throttle, retry pacing).

### Verification

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm lint` — unchanged (5 pre-existing warnings, none related to this change).
- `pnpm --filter @wrightful/dashboard test` — 76/77 pass; the 1 failure remains the pre-existing `run-detail-scoping.test.ts` stack overflow.
- Manual UI walkthrough still pending alongside the rest of the filter-bar checks above.
