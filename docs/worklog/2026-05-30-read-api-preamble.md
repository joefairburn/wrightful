# 2026-05-30 — Read-API loader preamble, owner-gate & error-outcome policy

## What changed

Consolidated four families of behaviour that were smeared across many handlers/loaders into small, unit-tested seams, turning shallow per-file rituals into deep modules: the read-API tenant preamble, the settings owner/member gate, the dual-mode request-body read, the global error-outcome policy, and the shared per-request bundle shapes.

This entry covers the `read-api-preamble` cluster of the 2026-05-30 architecture deepening review (findings F35, F34, F57, F40, F39, F73, F38, F75 — see `docs/reviews/2026-05-30-architecture-deepening-review.html`).

## Details

| Seam (file)                   | What it concentrates                                                                                                                                                                                                                                                                                                                                                 | Findings      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `src/lib/tenant-api-scope.ts` | `readTenantApiParams` (pure param extraction + required-`testResultId` policy → `null`) and `resolveTenantApiScope(c, opts)` (impure wrapper: `requireAuth` → params → `tenantScopeForUserBySlugs` → leak-safe-404). Replaces the identical `requireAuth → c.req.param → 404 → scope → 404` ritual open-coded in 4 read-API handlers.                                | F35           |
| `src/lib/run-results-page.ts` | `loadRunResultsPage(scope, runId, opts)` — the one canonical "first page of a run's testResults as `RunProgressTest[]`" (11-column projection, `(createdAt DESC, id DESC)` ordering, `projectId+runId` scoping, opaque base64 cursor, status normalization). Pure helpers `decodeCursor`/`encodeCursor`/`clampRunResultsLimit`/`normalizeTestStatus`.                | F34           |
| `src/lib/settings-scope.ts`   | Deepened with `requireMemberScope` (member-gated loaders), and the `gateTeamScope`/`gateOwnedProject` pure gates + `resolveOwnedTeam`/`resolveOwnedProject` status-agnostic cores (throw `AuthzError`, no HTTP status) that the page seams render as 404 and the API handlers render as 403. Replaces hand-rolled owner/member gates in 3 loaders + 2 API handlers.  | F57, F40, F73 |
| `src/lib/form.ts`             | `readBodyField(c, { jsonKey, formKey })` — the dual-mode body read (sniff `content-type`; JSON branch confines the unsafe cast + typeof guard; FormData slow-path; trimmed). Malformed JSON deliberately propagates as before.                                                                                                                                       | F39           |
| `src/lib/error-outcome.ts`    | `mapErrorOutcome(status)` (401→redirect-login / 404→rewrite-404 / else→log-and-oops) and `shouldLogApiFailure(status)` (raw-throw or ≥500), plus `isApiPath`/`isErrorPage`/`looksLikeStaticAsset`. The two arms of `middleware/00.errors.ts` (thrown-Response catch arm vs swallowed-HTTPException post-`next()` arm) now differ only in how they derive the status. | F38           |
| `src/lib/shared-bundle.ts`    | `SharedBundle` + re-exported `ResolvedActiveTeam`/`ResolvedActiveProject`/`WorkspaceListItem` (owned by `authz.ts`). Replaces 4+ local `Team`/`Project` mirrors in `01.context.ts`, `app-layout.tsx`, `workspace-switcher.tsx`, keeping the branded `TeamRole` precise to the owner gate.                                                                            | F75           |

### Call sites migrated

- Read-API handlers: `routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/summary.ts`, `test-preview.ts`, `results.ts`, and `tests/[testResultId]/summary.ts` → `resolveTenantApiScope`.
- `results.ts` + `pages/.../runs/[runId]/index.server.ts` → `loadRunResultsPage` (the SSR seed for `useRunProgress` and the back-paginator now share one definition and cannot diverge). `RunResultsResponse`/`LoadRunResultsOpts` now sourced from `run-results-page.ts` in `api-response-types.ts`.
- Settings loaders: `members.server.ts`, `projects.server.ts`, `general.server.ts` → `requireMemberScope`; `projects/new.server.ts` → `requireOwnerScope` (dropping the now-unused `requireTeamOwner`).
- Owner-only API handlers: `routes/api/teams/[teamSlug]/p/[projectSlug]/keys.ts` and `routes/api/teams/[teamSlug]/invites.ts` → `resolveOwnedProject`/`resolveOwnedTeam` (mapping `AuthzError` → 403) + `readBodyField`.
- `middleware/00.errors.ts` → `error-outcome.ts` policy; `middleware/01.context.ts`, `app-layout.tsx`, `workspace-switcher.tsx` → `shared-bundle.ts` types.

### F73 note

F73's leaky-seam defect (`requireTeamOwner` throwing a bare `Error("forbidden")`) was already remediated by the committed sibling settings-scope design: the owner path now flows through `resolveOwnedTeam`/`resolveOwnedProject` raising the typed `AuthzError`, and `requireTeamOwner` is gone entirely. No behavioural change was needed; a regression test locks the invariant.

## Tests

New unit-test surfaces (62 cases) covering the extracted pure logic:

- `src/__tests__/tenant-api-params.test.ts` — `readTenantApiParams` presence/required-`testResultId` policy.
- `src/__tests__/run-results-page.test.ts` — cursor encode/decode round-trip + malformed degradation, limit clamping, status normalization.
- `src/__tests__/settings-scope.test.ts` — `gateTeamScope`/`gateOwnedProject` leak-avoidance (404-not-403) + `AuthzError` invariant.
- `src/__tests__/read-body-field.test.ts` — JSON vs FormData branch, typeof guard, trimming.
- `src/__tests__/error-outcome.test.ts` — `mapErrorOutcome` decision table + `shouldLogApiFailure` predicate.
- `src/__tests__/shared-bundle.test.ts` — bundle shape parity with `authz.ts` sources.

The impure wrappers (`resolveTenantApiScope`, `loadRunResultsPage`'s D1 reads, `resolveOwnedTeam`/`resolveOwnedProject`) hit `void/db` and Hono `Context`, so they remain integration gaps under the vitest `void/db` stub; the pure cores they delegate to are fully covered.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (exit 0).
- `pnpm --filter @wrightful/dashboard test` — 290 passed (28 files; up from 192 baseline as the cluster added tests).
- `pnpm --filter @wrightful/reporter test` — 150 passed (11 files).
- `pnpm check` — 0 errors, 77 warnings (all pre-existing in `packages/reporter`), exit 0.
