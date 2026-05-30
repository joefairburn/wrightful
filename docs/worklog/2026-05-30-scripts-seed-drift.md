# 2026-05-30 — Scripts & seed drift: canonical create path, env-var name, shared ingest client & wire builder

Cluster `scripts-seed-drift`. This is the umbrella entry for findings
**F59–F64 + F69**; each has its own detailed sibling worklog (linked below).
It records the cluster as a whole, the cross-finding integration, and the
combined verification.

## What changed

The local-dev / seed / e2e tooling had drifted into a pile of private,
untested re-implementations of contracts the app already owns. Six seams were
extracted (or, for F69, confirmed already-shared by a sibling) so the scripts
consume one canonical surface each instead of hand-rolling weaker copies:

1. **Canonical create path (F59)** — slug-derivation + insert logic, previously
   inlined and duplicated across the two create-form actions and reachable
   out-of-process only by screen-scraping the form action's 302 `Location`
   header, now lives in `src/lib/provisioning.ts`. Exposed as owner-auth'd JSON
   routes `POST /api/teams` and `POST /api/teams/:teamSlug/projects`; both the
   form actions and the bootstrap scripts (seeder, e2e fixture) call the same
   code. Also fixed a live bug: `seed-demo.mjs` was minting its API key against
   a `/keys?createKey` route + `wrightful_reveal_key` cookie that an earlier
   commit had already deleted.
2. **One ingest env-var name (F60)** — `seed-demo.mjs` read
   `process.env.WRIGHTFUL_BASE_URL` while every other consumer (reporter, e2e,
   upload-fixtures, public docs) uses `WRIGHTFUL_URL`, forcing `setup-local.mjs`
   to set two names. Unified on `WRIGHTFUL_URL`.
3. **Shared ingest client (F61)** — `setup-local.mjs`'s `--history` path
   inlined a bare, no-retry `postJson` client (with a hand-retyped
   `"X-Wrightful-Version": "3"`) that duplicated `StreamClient`. Re-exported
   `StreamClient` from `@wrightful/reporter` and routed the history seeder
   through it via a new side-effect-free `scripts/seed/ingest-runs.mjs` loop.
4. **Shared v3 payload builder (F63)** — the history seeder's `generator.mjs`
   hand-built the v3 wire payload (open run-meta + planned tests, per-test
   results, complete payload) as a _third_ untested copy of the contract.
   Extracted `packages/reporter/src/payload.ts` as the single builder, exported
   it from the reporter, and had the generator consume it.
5. **Shared readiness probe + dev-server runner (F64)** —
   `upload-fixtures.mjs` carried a verbatim copy of the dashboard-readiness
   probe and a bespoke spawn+poll+SIGINT/SIGTERM dev-server runner. Extracted
   `scripts/lib/probe-status.mjs` and consolidated the runner into
   `scripts/lib/dev-server.mjs`.
6. **Shared seed `sha40` (F62)** — two divergent, unshared 40-hex commit-SHA
   generators (`generator.mjs` drew from the shared xorshift32 PRNG;
   `upload-fixtures.mjs` self-seeded an LCG) collapsed into one
   `scripts/seed/catalog.mjs` helper.
7. **Token-signer drift (F69, partial)** — the only deepening value in F69
   (the `ARTIFACT_TOKEN_SECRET ?? BETTER_AUTH_SECRET` precedence living in one
   place) was already resolved by sibling F62's working-tree change. F69 here
   was limited to a small `packages/e2e/src/e2e.test.ts` assertion tightening.

## Details

| Finding | Seam introduced / changed                                     | Primary consumers re-pointed                               |
| ------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| F59     | `src/lib/provisioning.ts` + `POST /api/teams`, `.../projects` | both form actions, `seed-demo.mjs`, `dashboard-fixture.ts` |
| F60     | (rename) `WRIGHTFUL_BASE_URL` → `WRIGHTFUL_URL`               | `seed-demo.mjs`, `setup-local.mjs`                         |
| F61     | re-export `StreamClient`; `scripts/seed/ingest-runs.mjs`      | `setup-local.mjs` history path                             |
| F62     | `scripts/seed/catalog.mjs` `sha40`                            | `generator.mjs`, `upload-fixtures.mjs`                     |
| F63     | `packages/reporter/src/payload.ts` v3 builder                 | `generator.mjs` (via `setup-local.mjs`)                    |
| F64     | `scripts/lib/probe-status.mjs`, `scripts/lib/dev-server.mjs`  | `upload-fixtures.mjs`                                      |
| F69     | (no new seam — half done by F62) assertion tightening         | `packages/e2e/src/e2e.test.ts`                             |

The `scripts/` tree is `.mjs` glue outside the typechecked `src` program, so
JSDoc-typed seams ship a hand-written `*.d.mts` (`ingest-runs.d.mts`,
`catalog.d.mts`, `probe-status.d.mts`) to let the `src/__tests__` tests import
them with real types instead of implicit `any`.

`setup-local.mjs`'s history path now builds the reporter first (the seeder's
`StreamClient` and the generator's v3 payload builders both resolve out of
`packages/reporter/dist`) before importing either, so a missing build fails
loudly instead of with an opaque module-not-found — the same guard
`upload-fixtures.mjs` already uses before Playwright loads the reporter.

## Cross-finding integration

- The seeder's ingest loop (F61) drives the _same_ synthetic runs the v3
  payload builder (F63) produces, through the _same_ `StreamClient` the
  reporter uses in production — open → chunked append (batches of 50, clear of
  the D1 ≤99-param ceiling) → complete with a backdated `completedAt`.
- `StreamClient.openRun` returns `{ runId, runUrl }`, which structurally
  satisfies the `{ runId }` shape `ingest-runs.mjs` consumes; the loop ignores
  `runUrl`. No adapter needed.
- The new JSON create routes (F59) are deliberately **not** in `isIngestRoute`
  (`src/lib/ingest-routes.ts`), so the Bearer-key auth gate (`middleware/
02.api-auth.ts`) skips them and they authenticate via the dashboard session
  (`requireAuth` / `resolveOwnedTeam`) — same as the existing invites/keys
  routes.

## Schema

No schema change: this cluster touches only scripts, tooling, and the
provisioning/ingest seams. No new `runs` column, so no new Drizzle migration.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 53 files / 596 tests pass
  (was ~192 before the cluster work began). New unit tests:
  `provisioning-slug.test.ts`, `dev-server-probe.test.ts`,
  `seed-ingest-runs.test.ts`, `seed-sha40.test.ts`.
- `pnpm --filter @wrightful/reporter test` — 14 files / 194 tests pass
  (was ~136). New: `payload.test.ts`; extended `client.test.ts`,
  `contract.test.ts`.
- `pnpm check` — 0 errors, 88 warnings (the new `no-unsafe-type-assertion`
  warnings on the e2e fixture's JSON-body casts match the file's pre-existing
  convention; within the project's accepted warning budget).

## Integration gaps (honest)

- The provisioning `create*` functions and the JSON routes hit `void/db`
  (stubbed in vitest), so only the pure slug surface (`slugifyName` /
  `pickUniqueSlug`) is unit-tested; the DB insert + route auth gating are
  exercised end-to-end only by the e2e dashboard fixture.
- The seeder ingest loop is unit-tested against a recording fake client; the
  real D1 round-trip is exercised only when `pnpm setup:local --history` runs.

## Per-finding worklogs

- `2026-05-30-provisioning-seam-and-json-create-routes.md` (F59)
- `2026-05-30-history-seeder-streamclient.md` (F61)
- `2026-05-30-seeder-v3-payload-builder.md` (F63)
- `2026-05-30-readiness-probe-seam.md` (F64)
- `2026-05-30-seed-sha40-shared.md` (F62)

(F60 and the F69 assertion tightening were small enough to fold into their
sibling entries / this umbrella.)
