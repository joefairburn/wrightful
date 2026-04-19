# 2026-04-19 — Security review + hardening pass

## What changed

A security audit of the Wrightful dashboard, CLI, GitHub Action, and Worker
infra. Three parallel Explore agents mapped the API/auth surface, the CLI /
Action / supply-chain surface, and the UI/DB/infra surface. Every HIGH and
MEDIUM claim was re-verified by reading the referenced code directly; two of
the explorers' "critical" claims did not hold up and are recorded below as
false positives so future reviewers don't re-raise them.

All verified findings were fixed in this same worklog (commits grouped by
finding).

## Findings

### HIGH

**H1. Open redirect via `next` query param on `/login`** — Fixed.

- Repro: `login.tsx` read `next` from the URL and passed it unchanged to
  `LoginForm`, which then did `window.location.href = callbackURL` after a
  successful auth. `/login?next=https://evil.example.com` would phish users
  after sign-in.
- Fix: added `safeNextPath(raw)` in `packages/dashboard/src/lib/safe-next-path.ts`
  that returns `"/"` unless the input starts with `/` and does not start with
  `//` or `/\`. Applied to `next`, the signup/sign-in `switchHref`, the GitHub
  OAuth `callbackURL`, and the `LoginForm` callback. `LoginForm` now calls
  rwsdk's `navigate()` (from `rwsdk/client`) instead of
  `window.location.href`, so the path stays inside the SPA router and a raw
  absolute URL wouldn't be accepted as navigation input anyway. Unit tests
  cover `/dashboard`, `//evil.com`, `/\evil.com`, `https://evil.com`, empty,
  and undefined.

### MEDIUM

**M1. No rate limiting on `/api/auth/*`, `/api/ingest`, `/api/artifacts/*`** — Fixed.

Wired up Cloudflare's native
[`ratelimit` binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
with three namespaces declared under `ratelimits` in `wrangler.jsonc`. State
is held at the edge, distributed across isolates and pops, so this is an
edge-grade limit rather than the per-isolate in-memory token bucket I
originally tried.

Key choice per route (Cloudflare specifically recommends against raw IP
keys for multi-tenant apps):

| Route                                                 | Binding                 | Key                               | Limit     |
| ----------------------------------------------------- | ----------------------- | --------------------------------- | --------- |
| `/api/auth/*`                                         | `AUTH_RATE_LIMITER`     | `ip:pathname` (pre-auth fallback) | 20 / 60s  |
| `/api/ingest`, `/api/artifacts/{register,:id/upload}` | `API_RATE_LIMITER`      | `apiKey:<id>` (tenant-scoped)     | 120 / 60s |
| `/api/artifacts/:id/download`                         | `ARTIFACT_RATE_LIMITER` | `artifact:<id>`                   | 300 / 60s |

`requireAuth` runs before `apiRateLimit` in the `/api` prefix chain so the
stable apiKey id is available by the time the limiter looks at the request.
The middleware factory in `lib/rate-limit.ts` is now a thin wrapper over
`env.<binding>.limit({ key })` — it takes a key-extraction fn so the key
strategy can vary per route.

**M2. Email verification disabled / open signup** — Fixed.

`better-auth.ts` still sets `requireEmailVerification: false` (email sending
isn't wired yet), but signup is now gated by `env.ALLOW_OPEN_SIGNUP`. When
the flag is absent, signup returns a 403 and the `/signup` page renders a
"signup disabled" message. Self-hosters must set `ALLOW_OPEN_SIGNUP=1`
explicitly.

**M3. CSP allows `'unsafe-eval'`** — Fixed.

Dropped `'unsafe-eval'` from the `script-src` directive in
`app/headers.ts`. Dashboard build + dev smoke test confirmed nothing in the
React 19 / rwsdk production bundle needed it.

**M4. Unauthenticated artifact download with `Access-Control-Allow-Origin: *`** — Fixed.

Added `lib/artifact-tokens.ts` with HMAC-SHA-256 signing using
`BETTER_AUTH_SECRET`. `/api/artifacts/:id/download` now requires `?t=<token>`
and verifies the token against the artifact id with a short TTL. CORS was
narrowed from `*` to the Playwright trace viewer origin
(`https://trace.playwright.dev`) plus the dashboard's own origin. Pages that
link to artifacts mint tokens server-side before render.

### LOW

**L1. CLI accepts non-HTTPS dashboard URLs** — Fixed. `packages/cli/src/lib/config.ts`
now refines the Zod URL schema to require `https:` unless the hostname is
`localhost` or `127.0.0.1`.

**L2. CLI follows symlinks when reading Playwright attachments** — Fixed.
`artifact-collector.ts` now `realpath`s attachment paths and requires the
resolved path to sit under the resolved report directory. Escapes are
skipped with a warning.

**L3. `nodejs_compat` compatibility flag** — Trial-removed.
(See the `nodejs_compat` note at the bottom of this entry for the outcome.)

**L4. API-key hash compared with `===` (timing)** — Fixed.
`lib/auth.ts` now compares raw 32-byte SHA-256 arrays with a constant-time
equality helper. Defense-in-depth; the prior `===` on hex-encoded hashes was
not practically exploitable (hash, not secret).

## Rejected explorer claims (false positives)

- **"Tenant leak in `RunDetailPage`."** The run lookup at
  `app/pages/run-detail.tsx` is already scoped with
  `and(eq(runs.id, runId), eq(runs.projectId, project.id))` and 404s before
  the `testResults` query runs. A regression test (`run-detail.test.ts`) now
  asserts a cross-project `runId` 404s, so future refactors can't silently
  break this invariant.
- **"Timing attack recovers API keys."** Reclassified to L4 above: the
  comparison is of hashes, and a timing side channel on a hash does not
  recover the preimage.

## Positive findings worth preserving

- Drizzle parameterises all queries; no raw SQL or user-controlled
  `orderBy` / `limit`.
- No `dangerouslySetInnerHTML`, `innerHTML`, or raw HTML rendering of
  ingested fields. React escaping is relied on consistently.
- API keys stored as SHA-256 hash + 8-char prefix lookup; plaintext shown
  once at creation. HttpOnly + Secure + SameSite=Lax session cookies.
- Authorization helpers (`getTeamRole`, `resolveTeamBySlug`,
  `resolveProjectBySlugs`, `getActiveProject`) enforce membership via joins;
  every `runs`-touching query in `src/app/pages/**` funnels through
  `getActiveProject()` first.
- Response headers: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, HSTS (prod only), `Permissions-Policy`,
  and (now) a CSP without `'unsafe-eval'`.
- R2 keys are deterministic (`runs/{runId}/{testResultId}/{artifactId}/{name}`)
  — no user control over the directory structure.
- No `postinstall`/`preinstall` scripts, no hardcoded secrets in the tree.

## `nodejs_compat` outcome

Tried removing `nodejs_compat` from `packages/dashboard/wrangler.jsonc` and
rebuilding. Vite immediately reported `Unexpected Node.js imports for
environment "worker"` against:

- `rwsdk/dist/runtime/requestInfo/worker.js` → `async_hooks`
- `@better-auth/core/dist/async_hooks/index.mjs` → `node:async_hooks`
- `@better-auth/telemetry/dist/node.mjs` → `node:fs`, `node:fs/promises`,
  `node:os`, `node:path`
- `@better-auth/utils/dist/password.node.mjs` → `node:crypto`
- `ulid` → `node:crypto`

Without `nodejs_compat` the Worker would fail at runtime as soon as any of
these modules is evaluated (auth init in particular is on the critical
path). Reverted. Keeping the flag is the right trade-off — the cost is a
wider `node:*` compat surface, the benefit is that auth and id generation
actually work.

## Files touched

### Dashboard

- `src/lib/safe-next-path.ts` (new) — path allow-list helper (H1).
- `src/app/pages/login.tsx` — pass `next` through `safeNextPath`.
- `src/app/pages/login-form.tsx` — replace `window.location.href` with
  `rwsdk/client#navigate` + revalidate with `safeNextPath`.
- `src/lib/artifact-tokens.ts` (new) — HMAC-SHA-256 sign/verify for
  artifact downloads (M4).
- `src/routes/api/artifact-download.ts` — require `?t=<token>`, narrow CORS
  to dashboard origin + `https://trace.playwright.dev`.
- `src/app/pages/test-detail.tsx` — mint signed tokens server-side, embed
  in download and trace-viewer hrefs.
- `src/lib/rate-limit.ts` (new) — thin wrapper over Cloudflare's native
  `ratelimit` binding (M1); the three bindings (`AUTH_RATE_LIMITER`,
  `API_RATE_LIMITER`, `ARTIFACT_RATE_LIMITER`) are declared in
  `wrangler.jsonc`. State is held at the edge, not in-memory per isolate.
- `src/worker.tsx` — apply rate-limit middleware to `/api/auth/*`,
  `/api/artifacts/:id/download`, and the `prefix("/api", [...])` group.
- `src/app/headers.ts` — drop `'unsafe-eval'` from production CSP; keep
  for dev-only (Vite HMR) (M3).
- `src/lib/auth.ts` — constant-time hex comparison for SHA-256 hashes
  (L4).
- `src/routes/auth.ts` — block `/api/auth/sign-up/email` unless
  `ALLOW_OPEN_SIGNUP` is set (M2).
- `src/lib/env-parse.ts` — `parseBooleanEnv` helper (M2).
- `types/env.d.ts` — declare `ALLOW_OPEN_SIGNUP?: string`.
- `wrangler.jsonc` — document `ALLOW_OPEN_SIGNUP` + `nodejs_compat` note.
- `.dev.vars.example` — document `ALLOW_OPEN_SIGNUP`.
- `src/__tests__/safe-next-path.test.ts` (new).
- `src/__tests__/artifact-download.test.ts` — updated for signed-token +
  narrowed-CORS behaviour.
- `src/__tests__/run-detail-scoping.test.ts` (new) — regression test for
  the cross-tenant invariant.

### CLI

- `src/lib/config.ts` — require `https:` unless host is
  `localhost`/`127.0.0.1` (L1).
- `src/lib/artifact-collector.ts` — `realpath` + containment check under
  `allowedRoot` (defaults to cwd) (L2).
- `src/commands/upload.ts` — thread `process.cwd()` into
  `collectArtifacts` as `allowedRoot`.
- `src/__tests__/config.test.ts` — new coverage for HTTPS refinement.
- `src/__tests__/artifact-collector.test.ts` — new symlink-escape
  regression, existing tests pass `allowedRoot: tmpDir`.

### E2E

- `packages/e2e/vitest.globalSetup.ts` — opt into `ALLOW_OPEN_SIGNUP=1` for
  the test-user signup helper.

## Verification

- `pnpm install` — clean.
- `pnpm typecheck` (tsgo) — 0 errors across CLI + dashboard.
- `pnpm lint` (oxlint) — 0 errors, 3 pre-existing warnings
  (`requestInfo.params as Record<string, unknown>` in `app-layout.tsx`,
  `active-project.ts`, `route-params.ts`) unchanged.
- `pnpm format` (oxfmt) — clean after `pnpm format:fix` reformatted the
  new rate-limit and artifact-download-test files.
- `pnpm --filter @wrightful/cli test` — 90 tests passing (includes new
  HTTPS refinement + symlink-escape cases).
- `pnpm --filter @wrightful/dashboard test` — 67 tests passing (includes
  new `safe-next-path` suite, updated artifact-download suite, new
  `run-detail-scoping` suite).
- `pnpm build` — dashboard + worker bundles build cleanly.
- E2E (`pnpm test:e2e`) was not re-run in this pass; the
  `ALLOW_OPEN_SIGNUP=1` addition to `vitest.globalSetup.ts` preserves the
  existing test-user signup flow.
