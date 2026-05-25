# 2026-05-23 — Drop nuqs, native URL state for Void (`packages/dashboard-void`)

## What changed

Fixed the run-detail page (`/t/:teamSlug/p/:projectSlug/runs/:runId`)
which was hanging the Worker on SSR.

Root cause: `dashboard-void` had three components calling `useQueryState`
from `nuqs` (`RunHistoryBranchFilter`, `attempt-tabs`, `visual-diff-dialog`),
but no `NuqsAdapter` was mounted anywhere. The default nuqs adapter
context throws `nuqs requires an adapter to work with your framework`
whenever a `useQueryState` consumer renders. During SSR that aborted the
React render and left the Worker promise unresolved — miniflare timed it
out as "code had hung." Only the run-detail and test-detail page chains
broke because the runs list, settings, login etc. don't use nuqs.

First pass shipped a Void-aware custom nuqs adapter. Second pass dropped
nuqs entirely in favour of two small native hooks, since:

1. The biggest URL-state consumer in the package
   (`runs-filter-bar.tsx`) already does it without nuqs, via
   `useNavigate()` + `toSearchParams()` from `src/lib/runs-filters.ts`.
   The three nuqs consumers were the odd ones out.
2. Each consumer needed only a single-key string param. No
   `parseAsInteger`, no array params. nuqs was overkill.
3. Two of the three (`attempt-tabs`, `visual-diff-dialog`) want shallow
   updates — change the URL without re-running the loader. The third
   (`RunHistoryBranchFilter`) wants the opposite — the URL drives what
   the loader returns. Void's router only exposes the navigating
   primitive; for shallow writes you need `history.replaceState`.

## Files added / changed

| Path                                                                   | Change                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard-void/src/lib/use-search-param.ts`                  | NEW. Two hooks: `useSearchParam` (shallow, `history.replaceState`) and `useNavigatingSearchParam` (full re-fetch via `router.visit`). Shared listener set so multiple consumers re-render on each write.                                         |
| `packages/dashboard-void/src/components/run-history-branch-filter.tsx` | Swap `useQueryState` → `useNavigatingSearchParam("branch", defaultValue)`.                                                                                                                                                                       |
| `packages/dashboard-void/src/components/attempt-tabs.tsx`              | Swap `useQueryState` → `useSearchParam("attempt", defaultValue)` + local membership check for stale URL values.                                                                                                                                  |
| `packages/dashboard-void/src/components/visual-diff-dialog.tsx`        | Swap `useQueryState` → `useSearchParam("vmode", "diff")`. Simplified the missing-frame fallback to one expression.                                                                                                                               |
| `packages/dashboard-void/pages/layout.tsx`                             | No adapter to mount anymore — reverted to the original root layout.                                                                                                                                                                              |
| `packages/dashboard-void/package.json`                                 | Removed `nuqs` from `dependencies`.                                                                                                                                                                                                              |
| `packages/dashboard-void/vite.config.ts`                               | (Earlier in the session.) Removed redundant standalone `babel({ presets: [reactCompilerPreset()] })` — `voidReact()` already wraps `react()` and sets `resolve.dedupe`. Added explicit `resolve.dedupe: ["react", "react-dom"]` belt-and-braces. |
| `packages/dashboard-void/src/lib/nuqs-adapter.tsx`                     | DELETED. Replaced by the native hooks above.                                                                                                                                                                                                     |

## How the hooks work

```ts
import {
  useSearchParam,
  useNavigatingSearchParam,
} from "@/lib/use-search-param";

// Shallow: URL mirrors UI state, page already has all data
const [tab, setTab] = useSearchParam("attempt", "1");

// Navigating: URL change must re-fetch the loader
const [branch, setBranch] = useNavigatingSearchParam("branch", defaultValue);
```

Read path is identical: a single `useSyncExternalStore` subscribes to
`popstate` plus a manual `notify()` triggered by shallow writes (since
`history.pushState`/`replaceState` don't fire `popstate`). On SSR the
initial value is sourced from `useRouter().query` — Void wraps the page
in `RouterContext.Provider` with `createSsrRouter(pageObj.url)` during
SSR, so the request URL is available.

Write path differs:

- `useSearchParam` → `history.replaceState(state, "", url)` + `notify()`.
  No loader re-run; sibling consumers re-render via the shared listener.
- `useNavigatingSearchParam` → `useNavigate()(url, { history: "replace" })`,
  which delegates to `router.visit(url, { replace: true })`. The loader
  re-runs, Void re-renders the page, the hooks pick up the new URL on
  the next render via the live `getSnapshot` reading
  `window.location.search`. No notify needed.

## Why no nuqs

`nuqs` shines for type-safe parsers (`parseAsInteger`,
`parseAsArrayOf(parseAsString)`), default-value semantics
(`clearOnDefault`), and multi-key state. None of the three consumers
in this package used any of that — each is one string key with a
hardcoded default. The library plus the custom adapter together was
~110 LOC of indirection (the adapter file plus a transitive dep)
replacing what is now ~85 LOC of focused, framework-aware code that
reads as the canonical shape.

If a future filter needs richer parsing, keep this file's shape and add
typed wrappers (e.g. `useEnumSearchParam<T>(key, values, default)`)
rather than bringing nuqs back.

## Verification

```bash
cd packages/dashboard-void
pnpm exec tsc --noEmit            # 0 errors
pnpm exec vp test run             # 81 tests pass
pnpm exec vp check src/lib/use-search-param.ts \
                   src/components/run-history-branch-filter.tsx \
                   src/components/attempt-tabs.tsx \
                   src/components/visual-diff-dialog.tsx \
                   pages/layout.tsx
# 0 errors, 0 warnings
```

Manual verification (user runs the dev server):

```bash
cd packages/dashboard-void
rm -rf .void node_modules/.vite   # clear void codegen + Vite prebundle
pnpm dev
# /t/demo/p/playwright/runs/<runId> — page renders. Toggle branch filter:
#   URL → ?branch=<name>, chart re-fetches via router.visit (no full reload).
# /t/demo/p/playwright/runs/<runId>/tests/<testResultId> — page renders.
#   Switch attempt tabs: URL → ?attempt=N, no loader re-run.
#   Open visual diff dialog: URL → ?vmode=<mode>, no loader re-run.
```
