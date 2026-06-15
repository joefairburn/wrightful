# 2026-06-14 — Polish bundle: date presets, density toggle, command-menu search (roadmap 4.1)

## What changed

Three independent "finish the existing stub" wirings, no schema changes.

### 4.1a — Date-range presets

`src/lib/date-range-presets.ts` (pure, injected `now` for deterministic tests)
computes `{ from, to }` `yyyy-MM-dd` bounds for four presets — **Today** (24h),
Last 7 days, Last 30 days, This month — surfaced as a column inside
`DateRangeFilter`'s popover in `runs-filter-bar.tsx`, calling the existing
`onApply(fromIso, toIso)` (URL/refetch plumbing unchanged). Bounds are computed
on the **UTC** calendar day, matching how `buildRunsWhere` interprets the
strings (`${from}T00:00:00.000Z` … `${to}T23:59:59.999Z`).

### 4.1b — Density toggle

`src/lib/density.ts` mirrors `src/lib/theme.ts` exactly (storage key `density`,
default comfortable, pure `prefersCompact`/`densityValue`, SSR-safe DOM helpers).
A `DensityToggle` sits beside `ThemeToggle` in `sidebar-user-menu.tsx`, and the
FOUC boot script (`theme-init-script.ts`, injected in `<head>` by
`middleware/01.head.ts`) applies the `.density-compact` class **before first
paint** from the same constants, so there's no flash.

### 4.1c — Command-menu search

`CommandMenu` (⌘K) is re-enabled in `app-layout.tsx` and now does live,
project-scoped search in addition to static navigation:

- **Backend** `routes/api/t/[teamSlug]/p/[projectSlug]/search.ts` — session-authed
  (`resolveProjectApiScope`), typed `?q=` query param. Two groups, BOTH
  project-scoped via `src/lib/command-search.ts`: recent runs (`runScopeWhere`,
  `createdAt DESC`, capped) and distinct tests whose `title`/`file` LIKE-match the
  escaped term (`escapeLike` + `ESCAPE '\'`). `Cache-Control: private, max-age=15`.
- **Frontend** `command-menu.tsx` — a debounced (`useDebouncedValue`, 200 ms)
  TanStack `useQuery`, `enabled` only when the menu is open and a project is
  resolved, drives a **Recent runs** group (blank query) / **Tests** group (while
  typing). Server-matched test rows put `title + file` in the Autocomplete
  `value` so they survive the COSS `Command`'s client-side `list`-mode filter;
  selecting a row navigates to the run detail / filtered tests-catalog URL.

## Files

| Area           | Files                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presets        | `src/lib/date-range-presets.ts`, `src/components/runs-filter-bar.tsx`, `src/__tests__/date-range-presets.test.ts`                                                                            |
| Density        | `src/lib/density.ts`, `src/components/density-toggle.tsx`, `src/components/sidebar-user-menu.tsx`, `src/lib/theme-init-script.ts`, `src/__tests__/density.test.ts`                           |
| Command search | `src/components/command-menu.tsx`, `src/components/app-layout.tsx`, `routes/api/t/[teamSlug]/p/[projectSlug]/search.ts`, `src/lib/command-search.ts`, `src/__tests__/command-search.test.ts` |

## Adversarial review + fixes

Reviewed across search-route scoping, date presets, density FOUC, and command
UI. **7 confirmed of 16.** The search route's tenant scoping + `escapeLike`
escaping came back sound. Fixes:

- **(high) 4.1c was half-shipped** — the `/search` backend + `command-search.ts`
  existed but the frontend was the static 3-group menu with zero callers (dead
  backend). **Wired it**: `command-menu.tsx` now fetches the debounced,
  project-scoped search and renders the Recent-runs / Tests groups; the search
  route gained a typed `q` validator so the `void/client#fetch` call is
  type-safe. This also makes the "Search runs, tests, projects…" placeholder
  honest (the over-promise finding).
- **(medium) missing test** — `command-search.ts`'s doc-comment promised a
  `command-search.test.ts` that didn't exist. Added it: pins the projectId-scope
  invariant on both groups + the escaped LIKE pattern (`%a\%b%` + `ESCAPE '\'`).
- **(low) misleading preset label** — "Last 24 hours" → **"Today"** (the 24h
  preset is today→today, a whole UTC day, not a rolling 24 h).
- **(low) command-menu row keys** — switched the project/team switch rows from
  name-keyed (names aren't unique) to slug-keyed `id`s, decoupled from the
  filter `value`.

### Confirmed-but-deferred (documented, not changed)

- **(low) preset (UTC) vs custom-calendar (local) day boundary.** The presets
  anchor to the UTC day (matching `buildRunsWhere`'s UTC string interpretation);
  the calendar widget extracts the user's clicked _local_ day. They can differ by
  one day for non-UTC users in the narrow window where local-day ≠ UTC-day. Both
  naive "fixes" are regressive given the UTC-only filter — forcing the calendar to
  UTC shifts a UTC+ user's clicked day backward, and making the presets local
  de-aligns them from the filter's own UTC semantics. The real fix is timezone-
  aware filtering, which is out of scope for a polish wiring; left as a known
  limitation.
- **(low) density tokens have limited reach.** The toggle correctly flips
  `.density-compact`, but the density CSS tokens are currently consumed in only
  one component, so the visible effect is small. Broadening which primitives honor
  the density tokens is a separate styling pass (with its own visual-regression
  surface) rather than part of wiring the toggle; deferred.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (route `q` validator
  - the `void/client#fetch` `query` typing flow end-to-end).
- `pnpm --filter @wrightful/dashboard test` — **1113 passed** (101 files).
- `pnpm --filter @wrightful/dashboard run check` — **0 errors**.
- Manual ⌘K (recent runs / live test search / navigation) and density-persist
  FOUC checks need a running dev server — not run here.
