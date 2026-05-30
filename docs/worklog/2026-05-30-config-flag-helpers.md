# 2026-05-30 — Config & flag-derivation helpers; e2e secret-fallback parity

Cluster `config-flag-helpers`. Findings: **F92** (implemented), **F78** /
**F94** (already addressed by F92), **F91** (implemented).

## What changed

Three auth-surface decode rules that were each duplicated across several call
sites are now consolidated into one pure seam, `apps/dashboard/src/lib/config.ts`,
and the e2e HMAC forger was repointed to sign under the dashboard's _resolved_
artifact-token secret rather than re-deriving the precedence by hand.

### F92 / F78 / F94 — the flag-decode seam (`src/lib/config.ts`)

Three pure resolvers now own the single decode rule for each flag:

- `githubOAuthEnabled(source)` — the
  `Boolean(AUTH_GITHUB_CLIENT_ID && AUTH_GITHUB_CLIENT_SECRET)` predicate,
  treating an empty-string cred (allowed by `env.ts`'s `.optional()` string
  schema) as unset. Previously inlined in `login.server.ts`, `signup.server.ts`,
  `profile.server.ts`, and `auth.ts`.
- `openSignupAllowed(value)` — normalizes the `ALLOW_OPEN_SIGNUP` truthiness
  across the two env sources: the typed `env` already coerces to `boolean`
  (`boolean().default(false)`), while config-time `process.env` yields the raw
  string where only `"true"`/`"1"` (case-insensitive) count. Anything else,
  including `undefined`/`""`, is off.
- `resolveArtifactTokenSecret(source)` — the `ARTIFACT_TOKEN_SECRET ??
BETTER_AUTH_SECRET` presence-based precedence, previously inlined in
  `artifact-tokens.ts#getKey`.

F78 and F94 are sub-scopes of F92 (the github-enabled predicate and the
open-signup decode respectively, per the verifier's narrowed notes), so they are
fully satisfied by the same seam — no additional code.

The request-time loaders (`login`/`signup`/`profile`) import the resolvers.
`auth.ts` is the one config-time site that intentionally **inlines** the same
github + open-signup rules rather than importing them: `void prepare` evaluates
`auth.ts` in a bare-Node context that can't resolve the `@/lib` alias for a
static value import (the same reason its GitHub-mirror is a deferred dynamic
import). Its inline copy now carries a pointer back to `config.ts` so the two
stay in sync.

### F91 — cross-package artifact-secret parity (e2e ↔ dashboard)

The e2e suites forge artifact-download HMAC tokens that must validate against the
dashboard's real `verifyArtifactToken`. Previously the forger signed with
`BETTER_AUTH_SECRET` only, while the dashboard signs with
`ARTIFACT_TOKEN_SECRET ?? BETTER_AUTH_SECRET` — so the moment a deployment
provisioned a dedicated `ARTIFACT_TOKEN_SECRET`, the forger would silently
diverge and every artifact-download spec would break with no canary.

The boot fixture (`packages/e2e/src/dashboard-fixture.ts`) now:

- accepts an optional `artifactTokenSecret` boot option; when set it writes
  `ARTIFACT_TOKEN_SECRET` into the dashboard's `.env.local`, exercising the
  "rotate the artifact secret independently" production path;
- computes one `artifactTokenSecret = options.artifactTokenSecret ??
betterAuthSecret` — the same `?? BETTER_AUTH_SECRET` precedence as the
  dashboard's `resolveArtifactTokenSecret` — and exposes it on the
  `DashboardFixture`. Both the `.env.local` it writes and the value handed to the
  forger derive from this single computation, so they cannot diverge.

The vitest globalSetup (`vitest.globalSetup.ts`) now provides
`artifactTokenSecret` (replacing the raw `betterAuthSecret` it used to inject for
forging), and `e2e.test.ts`'s `signArtifactToken` signs with that injected
resolved secret. The Playwright `tests-dashboard` path serializes the new
`artifactTokenSecret` field through `global-setup.ts` /
`helpers/fixture.ts` (validator updated to require it).

## Details

| Change                                                                            | File                                                                                                                             | Why                                                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| New seam: `githubOAuthEnabled`, `openSignupAllowed`, `resolveArtifactTokenSecret` | `apps/dashboard/src/lib/config.ts`                                                                                               | One pure home per decode rule, normalizing across the config-time/request-time env sources.         |
| Import + apply the github/open-signup resolvers                                   | `pages/login.server.ts`, `pages/signup.server.ts`, `pages/settings/profile.server.ts`                                            | Drop the inlined predicates; the loaders read the seam.                                             |
| Inline copy + pointer comment                                                     | `apps/dashboard/auth.ts`                                                                                                         | Config-time site can't import the `@/lib` alias under `void prepare`; comment binds it to the seam. |
| `getKey()` uses `resolveArtifactTokenSecret(env)`                                 | `apps/dashboard/src/lib/artifact-tokens.ts`                                                                                      | The in-worker consumer of the secret-precedence rule.                                               |
| Docstring pointer to the resolver                                                 | `apps/dashboard/env.ts`                                                                                                          | `ARTIFACT_TOKEN_SECRET` fallback precedence is owned by the seam, not the env declaration.          |
| `artifactTokenSecret` boot option + resolved-secret exposure                      | `packages/e2e/src/dashboard-fixture.ts`                                                                                          | Single source of "what secret signs artifact tokens under this boot"; forger derives from it.       |
| Forge with the resolved secret; provide it through setup                          | `packages/e2e/src/e2e.test.ts`, `vitest.globalSetup.ts`, `tests-dashboard/global-setup.ts`, `tests-dashboard/helpers/fixture.ts` | The HMAC forger can never re-derive a different precedence than the producer.                       |

## Tests

- `apps/dashboard/src/__tests__/config.test.ts` (new) — unit-covers all three
  resolvers: github-enabled only when BOTH creds present (empty string is unset),
  open-signup boolean passthrough + string `"true"`/`"1"` coercion, and the
  artifact-secret `??` precedence (dedicated wins, absent falls back, explicit
  `""` is honored).
- `apps/dashboard/src/__tests__/artifact-tokens.test.ts` — the "e2e token forging
  contract" canary docstring updated: the clone now signs with the dashboard's
  _resolved_ secret, so producer/forger stay aligned even when a distinct
  `ARTIFACT_TOKEN_SECRET` is provisioned.

The actual e2e boot (real D1/R2 + `.env.local` writes) remains an integration
gap — the dashboard vitest harness stubs `void/db` — so only the pure resolvers
and the wire/forge contract are unit-tested here.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (codegen + tsgo, 0 errors).
- `pnpm --filter @wrightful/dashboard test` — 555 passed / 47 files (includes the
  new `config.test.ts`).
- `pnpm --filter @wrightful/reporter test` — 176 passed / 13 files.
- `pnpm check` — 0 errors, 84 warnings (all pre-existing `no-unsafe-type-assertion`
  in the reporter, untouched by this cluster).
