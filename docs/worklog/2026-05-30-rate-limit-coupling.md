# 2026-05-30 — Ingest route-shape seam, rate-limit config↔code guard, dead-factory removal

Cluster `rate-limit-coupling`. Findings: **F85** (implemented), **F86**
(implemented), **F74** / **F87** (already addressed by F86).

## What changed

Two duplications and one piece of dead code around the rate-limit/ingest auth
surface, now concentrated into testable seams.

### F85 — the ingest route-shape seam (`src/lib/ingest-routes.ts`)

"These reporter ingest routes must each require a Bearer key AND be throttled
per-tenant" is a single invariant, but it was expressed twice: the two regex
literals (`RUN_INGEST_RE` = `/^\/api\/runs(?:\/|$)/`, `ARTIFACT_INGEST_RE` =
`/^\/api\/artifacts\/(?:register|[^/]+\/upload)(?:\/|$)/`) lived byte-for-byte
in both `middleware/02.api-auth.ts` (the Bearer gate) and
`middleware/03.rate-limit.ts` (the throttle gate). Nothing failed at build or
test time if they drifted, and the two drift modes are both silent:

- authed in 02 but not throttled in 03 → unbounded per-tenant D1 writes;
- throttled in 03 but not authed in 02 → handler calls `getApiKey(c)`, which
  throws because 02 never stashed the key → a 500 instead of a clean 401.

Both gates now import a single pure predicate, `isIngestRoute(path)`, so the
route set lives in exactly one place and the two cannot drift. The matcher is
the new unit-test surface. The deliberately-excluded surfaces
(`/api/auth/*` → IP-keyed, `/api/artifacts/:id/download` → artifactId-keyed)
remain in `03` only — folding them in would be a pass-through, not a
concentration.

### F86 / F74 / F87 — rate-limiter names as a runtime source of truth + dead-factory removal (`src/lib/rate-limit.ts`)

Per the verifier's narrowing, F86 was implemented as the two load-bearing
pieces only (the `LIMITERS` spec-table was explicitly rejected as a
within-module reshuffle, not a deepening):

1. The dead `rateLimit()` per-route Hono-middleware factory was deleted. Nothing
   referenced it — the live path is the global `03.rate-limit.ts` gate calling
   `checkRateLimit` directly. Its `import type { MiddlewareHandler }` /
   `defineMiddleware` imports went with it, and the stale "Shared by the
   `rateLimit()` per-route factory and the global …" doc-comment on
   `checkRateLimit` was corrected to "Consumed by the global
   `middleware/03.rate-limit.ts` path-matched gate." This is the substance of
   the F74 / F87 duplicates, so they are fully addressed by the same edit.

2. The three rate-limiter binding names are now a runtime array,
   `RATE_LIMITER_BINDING_NAMES`, with the `RateLimiterBindingName` union
   _derived_ from it (`(typeof …)[number]`). The names previously existed only
   as a TS union — invisible to a test and unrelated to the deploy-time config
   in `wrangler.jsonc#ratelimits`. Exposing the array lets a test assert a
   bijection between the referenced names and the configured limiters.

## Details

| Change                                                                                                                         | File                                         | Why                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| New seam: `isIngestRoute(path)` + the two route regexes                                                                        | `apps/dashboard/src/lib/ingest-routes.ts`    | Single source of truth for the Bearer-authed + per-tenant-throttled ingest route set.                                                  |
| Import + apply `isIngestRoute` (drop inlined regexes)                                                                          | `apps/dashboard/middleware/02.api-auth.ts`   | The Bearer gate reads the seam; comment now points to it.                                                                              |
| Import + apply `isIngestRoute` for the API-key branch (drop inlined regexes)                                                   | `apps/dashboard/middleware/03.rate-limit.ts` | The throttle gate reads the same seam, so it can't drift from 02. The auth/download branches keep their own (single-consumer) regexes. |
| Delete dead `rateLimit()` factory + its `MiddlewareHandler`/`defineMiddleware` imports; fix stale `checkRateLimit` doc-comment | `apps/dashboard/src/lib/rate-limit.ts`       | The factory had zero callers; the comment described a non-existent two-adapter seam.                                                   |
| Export `RATE_LIMITER_BINDING_NAMES` (runtime array) and derive the union from it                                               | `apps/dashboard/src/lib/rate-limit.ts`       | Makes the binding-name set assertable against `wrangler.jsonc` config.                                                                 |

## Tests

- `apps/dashboard/src/__tests__/ingest-routes.test.ts` (new) — pins
  `isIngestRoute`: matches the five Bearer ingest routes; does NOT match the
  signed-token artifact download, the auth/session-authed API surfaces, or page
  paths; and anchors at the path start (no `/x/api/runs`, `/api/runscapes`,
  `/api/artifacts/register-thing` false positives).
- `apps/dashboard/src/__tests__/rate-limit-config.test.ts` (new) — config↔code
  drift guard. Reads `wrangler.jsonc` via a minimal JSONC reader and asserts:
  the configured `ratelimits[].name` set equals `RATE_LIMITER_BINDING_NAMES`;
  every name appears as a literal in `03.rate-limit.ts`; budgets order
  strict→loose (AUTH 20 < API 120 < ARTIFACT 300); and every limiter has a
  unique `namespace_id` with a positive period/limit.
- `apps/dashboard/src/__tests__/rate-limit.test.ts` — added a case driving the
  artifact-upload ingest path through `03` to a 429. The artifact half of the
  ingest surface had never been exercised through the middleware; because 02 and
  03 share `isIngestRoute`, pinning it here pins the matcher for both gates.

The middleware run against real D1/R2 remains an integration gap — the dashboard
vitest harness stubs `void/db` — so the unit tests cover the pure matcher, the
config bijection, and the fail-closed/fail-open behavior of `checkRateLimit`.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (codegen + tsgo, 0 errors).
- `pnpm --filter @wrightful/dashboard test` — 565 passed / 49 files (includes the
  two new test files + the new rate-limit case).
- `pnpm --filter @wrightful/reporter test` — 176 passed / 13 files.
- `pnpm check` — 0 errors, 85 warnings (all pre-existing `no-unsafe-type-assertion`
  in e2e/auth files, untouched by this cluster).
