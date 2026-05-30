# 2026-05-30 — Brand-enforced tenant scope seams (scoped-data-access + run-ownership)

## What changed

Made the branded `AuthorizedProjectId` / `AuthorizedTeamId` types **load-bearing at query consumption**, not just at id construction — closing the gap the architecture review flagged as its single highest-severity finding (the CLAUDE.md claim that the brand makes the `projectId` filter "impossible to forget" was only true at the _resolve_ step; every run-scoped query still re-derived the predicate by hand).

This entry covers the `scoped-data-access` and `run-ownership` clusters of the 2026-05-30 architecture deepening review (findings F07, F08, F11, F12, F14, F03, F09, F10, F36, F65 — see `docs/reviews/2026-05-30-architecture-deepening-review.html`).

## Details

New seams in `src/lib/scope.ts`:

| Export                       | Purpose                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeTenantScope(parts)`     | The single sanctioned launder from raw `string` ids into a `TenantScope`. The two `as Authorized*Id` casts now live in exactly one place; `tenantScopeForUserBySlugs`, `tenantScopeForApiKey`, and `tenant-context`'s `toScope` all funnel through it.                                        |
| `runScopeWhere(scope)`       | The blessed `(teamId, projectId)` predicate for the `runs` table — the only run-scoped table carrying both columns. Replaces the `and(eq(teamId), eq(projectId))` pair copy-pasted across the runs-list count/page, branch/actor/environment lookups, history query, and insights aggregates. |
| `runByIdWhere(scope, runId)` | The blessed `(projectId, runId)` single-row lookup predicate — the most-duplicated scope shape, previously hand-rolled in the ingest pipeline (open/append/complete/recompute), the run-detail and test-detail loaders, and the `/summary` + `/results` API routes.                           |

Both predicate builders take a `TenantScope` (not raw strings), so a query cannot be scoped from an un-auth-checked id without a type error.

Call sites migrated to consume the new helpers: `runs-filters-where.ts`, `branches-query.ts`, `tenant-context.ts`, `ingest.ts`, the runs-list / run-detail / test-detail / insights loaders, and the `runs/[runId]/results.ts` + `summary.ts` API routes.

## Tests

New `apps/dashboard/src/__tests__/scope-where.test.ts` pins the emitted predicate shapes (the brand-consumption invariant is now a unit-test surface rather than a convention).

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 192 passed.
- `pnpm check` — 0 errors, 79 warnings (down from 83 baseline).

## Note

These two clusters were implemented during the bulk review-implementation run but their commit gate was interrupted by a transient agent failure; the work was validated green and committed in this entry. Some review findings in these clusters may be only partially addressed (e.g. the `live.ts` `onSubscribe` join variant of the run-ownership probe); the final-review pass reconciles remaining items.
