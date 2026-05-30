# 2026-05-30 — Team/project provisioning seam + JSON create routes (F59)

## What changed

Concentrated the canonical create-team / create-project path behind a single
`src/lib/provisioning.ts` seam, and exposed it as owner-auth'd JSON API routes
so out-of-process bootstrap callers stop screen-scraping the human form-action
redirects.

Before this change, the slug-derivation + insert logic was inlined and
duplicated verbatim across the two create-form actions
(`pages/settings/teams/new.server.ts`,
`pages/settings/teams/[teamSlug]/projects/new.server.ts`), and the only way a
Node process could reach the canonical create path was to POST the human form
action with `redirect: "manual"` and infer success/failure by regex-matching
the 302 `Location` header. Two callers did exactly that — the local seeder
(`apps/dashboard/scripts/seed-demo.mjs`) and the e2e dashboard fixture
(`packages/e2e/src/dashboard-fixture.ts`). seed-demo.mjs additionally still
minted its API key against a route + cookie (`/keys?createKey` +
`wrightful_reveal_key`) that commit 1d854e3 had already deleted — so its key
step was a live, broken-on-next-run bug.

## Details

New module `src/lib/provisioning.ts`:

- `slugifyName(name)` / `pickUniqueSlug(base, taken)` — pure (the unit-test
  surface), lifted verbatim from the two form actions; `SLUG_MAX_LEN` exported.
- `createTeamForUser(userId, name)` → `{ slug }` — atomic team + owner-membership
  insert via `runBatch`.
- `createProjectForTeam(teamId, name)` → `{ slug }` — team-scoped project insert.
- `SlugDerivationError` — status-agnostic; the form action maps it to a
  `?error=` redirect, the JSON route to a 400. Its default message is the exact
  string the inlined actions used, so the no-JS error UX is byte-preserved.

New JSON routes (session auth; NOT in `isIngestRoute`, so the Bearer gate skips
them, same as the existing invites/keys routes):

- `POST /api/teams` → `{ teamSlug }` (auth'd; `requireAuth`).
- `POST /api/teams/:teamSlug/projects` → `{ projectSlug }` (owner-only via
  `resolveOwnedTeam`).

Both delegate to the provisioning seam. They mirror the conventions of the
existing `routes/api/teams/[teamSlug]/p/[projectSlug]/keys.ts` and `invites.ts`
(JSON body in, JSON body out, 403 on `AuthzError`).

Migrated all four call sites to the seam:

| Caller                          | Before                                                                                                          | After                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `teams/new.server.ts` action    | inline slug + batch insert                                                                                      | `createTeamForUser`                                                                                            |
| `projects/new.server.ts` action | inline slug + insert                                                                                            | `createProjectForTeam`                                                                                         |
| `seed-demo.mjs`                 | scrape team 302 `Location`; scrape project 302; mint via dead `/keys?createKey` + `wrightful_reveal_key` cookie | `POST /api/teams`, `POST /api/teams/:slug/projects`, `POST /api/teams/:slug/p/:proj/keys` (reads `body.token`) |
| `dashboard-fixture.ts`          | scrape team + project 302 `Location`                                                                            | the two JSON routes                                                                                            |

Net −154 lines across the four migrated files; the create logic now lives in
one ~170-line module consumed by four call sites.

## Scope notes

This implements the verifier-narrowed F59: the canonical create-path seam + JSON
routes + the seed-demo key-mint bug fix. The broader cluster items
(WRIGHTFUL_BASE_URL → WRIGHTFUL_URL env-name unification, exporting the reporter
`StreamClient` for the seeder, a shared v3 payload builder, shared readiness
probe) are sibling findings and were left untouched. No schema change was
needed (no new `runs` column).

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- e2e package `tsgo --noEmit -p tsconfig.json` — clean (dashboard-fixture edit).
- `vp test run` (dashboard) — 50 files / 576 tests pass, including the new
  `src/__tests__/provisioning-slug.test.ts` (11 cases over `slugifyName` /
  `pickUniqueSlug`: lowercasing, separator collapsing, trim, null-on-empty,
  `SLUG_MAX_LEN` cap + re-trim, `-2`/`-3` walk, no `--` after cap, 999-collision
  random-suffix fallback).
- `vp lint` on changed files — 0 errors. 4 `no-unsafe-type-assertion` warnings
  in `dashboard-fixture.ts` from the new `as { teamSlug?: unknown }` /
  `{ projectSlug?: unknown }` JSON-body casts, matching the file's pre-existing
  `keyBody` cast convention.

Integration gap (honest): the `create*` functions hit `void/db` (stubbed in
vitest), so only the pure slug surface is unit-tested. The DB-bound insert +
the two JSON routes' auth gating are exercised end-to-end only by the e2e
dashboard fixture (which now boots through them).
