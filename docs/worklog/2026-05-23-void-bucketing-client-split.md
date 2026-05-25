# 2026-05-23 — Split analytics bucketing into client-safe + SQL halves

Follow-up to the runs-filters split (where a single module mixed URL parsing
with Drizzle SQL builders and exploded on the client because `void/db` is a
stub there). Audited the `dashboard-void` package for the same trap; the
only remaining offender was `src/lib/analytics/bucketing.ts`.

## What changed

`bucketing.ts` did a top-level `import { sql } from "void/db"` and exported
both server-only (`bucketExpr`, `SqlBucketExpr`) and client-safe helpers
(`Segment`, `SEGMENTS`, `DAY_SEC`, `WEEK_SEC`, `parseSegment`,
`buildEmptyBuckets`, `bucketKey`). The three insights page components
(`insights/{index,run-duration,suite-size}.tsx`) value-import the client-safe
helpers, which would pull the whole module — including the `void/db` line —
into the client bundle. On the client this would throw
`SyntaxError: does not provide an export named 'sql'` at module-load, killing
hydration on the insights pages the same way the runs-filters bug killed
popovers on the runs page.

Split into two modules, mirroring the runs-filters shape:

- **New:** `src/lib/analytics/bucketing-sql.ts` — owns the `void/db` import,
  exports `bucketExpr` and the `SqlBucketExpr` type. Imports `Segment` from
  the client-safe module.
- **Modified:** `src/lib/analytics/bucketing.ts` — drops the `void/db` import
  and the `bucketExpr` / `SqlBucketExpr` exports. Now has no imports.
- **Modified:** the three insights `.server.ts` loaders
  (`pages/t/[teamSlug]/p/[projectSlug]/insights/{index,run-duration,suite-size}.server.ts`)
  — split their combined import into `bucketExpr` from `bucketing-sql` and
  the client-safe helpers from `bucketing`.

The three `.tsx` page components are unchanged; they already imported only
client-safe helpers.

## Files changed

| File                                                                 | Change                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/lib/analytics/bucketing-sql.ts`                                 | new — SQL builder + type                                |
| `src/lib/analytics/bucketing.ts`                                     | removed `void/db` import, `bucketExpr`, `SqlBucketExpr` |
| `pages/t/[teamSlug]/p/[projectSlug]/insights/index.server.ts`        | split import                                            |
| `pages/t/[teamSlug]/p/[projectSlug]/insights/run-duration.server.ts` | split import                                            |
| `pages/t/[teamSlug]/p/[projectSlug]/insights/suite-size.server.ts`   | split import                                            |

## Not changed, but worth noting

`src/lib/authz.ts` and `src/live.ts` also do top-level `void/db` imports, but
their client-side consumers (`src/lib/request-info.ts`,
`src/lib/active-project.ts`, `pages/index.tsx`, `src/lib/live-client.ts`)
reach them via `import type` only, so esbuild erases the reference. Safe
today; fragile if any client component later adds a value-import.

## Verification

- `pnpm exec tsc --noEmit` in `packages/dashboard-void/` — clean.
- No tests reference the analytics bucketing module (grepped).
- `src/lib/analytics/range.ts` still imports `DAY_SEC` from `./bucketing` —
  works (client-safe export preserved).
- Manual: load `/t/:teamSlug/p/:projectSlug/insights`, `/insights/run-duration`,
  `/insights/suite-size` in the dev server; charts render and segment/range
  toggles work without console errors. (Per repo convention, the dev server
  is run by the user, not the agent.)
