# 2026-04-20 — Runs list: pagination

## What changed

The All Runs page (`/t/:teamSlug/p/:projectSlug`) was silently truncating at 50 rows and its footer showed `Showing X of X` — no way to see earlier runs or know how many existed. Added URL-driven numbered pagination at a default page size of 20 using the existing `ui/pagination.tsx` primitive.

## Details

- Modified: `packages/dashboard/src/lib/runs-filters.ts`
  - Export `DEFAULT_PAGE_SIZE = 20`.
  - Added `page: number` to `RunsFilters` and `EMPTY_FILTERS` (defaults to `1`).
  - `parseRunsFilters` reads `?page=`, coerces via `parseInt`, defaults non-numeric / < 1 to `1`.
  - `toSearchParams` omits `page` when it's 1 to keep canonical URLs clean.
  - `hasAnyFilter` deliberately ignores `page` — pagination isn't a filter, so the empty-state copy ("No runs match your filters") stays accurate.
- Modified: `packages/dashboard/src/app/pages/runs-list.tsx`
  - Parallel `SELECT count(*)` query alongside the existing distinct-option queries. Uses the `runs_project_created_at_idx` index.
  - Main query now `.limit(DEFAULT_PAGE_SIZE).offset((currentPage - 1) * DEFAULT_PAGE_SIZE)`.
  - `currentPage = min(filters.page, totalPages)` — clamps out-of-range requests (`?page=999` on a 3-page result returns page 3, not empty).
  - New footer: `Showing {fromRow}–{toRow} of {totalRuns} runs` plus a numbered `Pagination` (Prev, windowed page numbers with ellipses, Next). Windowed helper `buildPageWindow(current, total)` always shows first/last, current ±1, and ellipses in the gaps.
  - Prev/Next disabled at the ends via `aria-disabled` + `pointer-events-none opacity-50`.
  - Header counter pill now shows `totalRuns`, not the current page length.
- Modified: `packages/dashboard/src/app/components/runs-filter-bar.tsx`
  - `applyFilters` now forces `page: 1` when navigating, so any filter change resets pagination. Prevents stranding the user on an out-of-range page after they narrow the result set.
- Modified: `packages/dashboard/src/__tests__/runs-filters.test.ts`
  - Added tests for `parseRunsFilters` page parsing (default, invalid, valid), `toSearchParams` page inclusion rules, round-trip, and `hasAnyFilter` ignoring `page`.
  - Updated existing `buildRunsWhere` test fixture to include the new `page` field.
- Modified: `packages/dashboard/scripts/upload-fixtures.mjs` + `setup-local.mjs`
  - Added opt-in `--volume` flag that appends 27 procedural scenarios on top of the 3 named ones (30 runs total) so pagination has enough data to exercise multiple pages. Default `setup:local` stays fast (~3 runs) — only opt in when specifically testing the runs list. Each volume scenario is still a full Playwright invocation routed through the real reporter path, so ingest / artifact handling is exercised for every row.

### URL param addition

| Param  | Example  | Notes                                        |
| ------ | -------- | -------------------------------------------- |
| `page` | `page=3` | 1-based; omitted when 1; clamped server-side |

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/runs-filters.test.ts` — 16/16 pass.
- `pnpm typecheck` — clean (both dashboard and reporter).
- `pnpm lint` — no new warnings from this change (9 pre-existing warnings unchanged).
- `pnpm --filter @wrightful/dashboard test` — 96/97 pass; the remaining failure (`run-detail-scoping.test.ts`) is pre-existing on `main` (stack overflow in test setup, unrelated to this change).
- Manual UI walkthrough pending — user runs `pnpm dev` themselves.
