# 2026-04-17 — Teams, projects, and always-on auth

## What changed

Added teams and projects as a first-class tenancy model in the dashboard,
plus sign-in via Better Auth (email + password, optional GitHub OAuth).
Every route is authenticated. URLs are always scoped:
`/t/:teamSlug/p/:projectSlug/...`. API keys, runs, and everything derived
from them are scoped to a project.

The CLI was not touched. The `/api/ingest` contract is unchanged; the
server derives `projectId` from the authenticating API key. Protocol
version stays at 2.

An earlier draft of this work was toggleable via a `WRIGHTFUL_MULTI_TENANCY`
flag with a seeded `default` team/project for off-mode. That was dropped
before shipping once email + password sign-in made auth cheap enough to
require everywhere: local installs only need `BETTER_AUTH_SECRET`, no
OAuth app registration.

## Details

### Schema

Added to `packages/dashboard/src/db/schema.ts`:

- `teams` (id, slug UNIQUE, name, createdAt)
- `projects` (id, teamId FK→teams, slug, name, createdAt, UNIQUE(teamId, slug))
- `memberships` (id, userId FK→user, teamId FK→teams, role: 'owner'|'member', UNIQUE(userId, teamId))
- Better Auth core: `user`, `session`, `account`, `verification` (canonical
  SQLite shape from `better-auth/adapters/drizzle`).
- `api_keys.projectId` NOT NULL FK → `projects(id)` (cascade).
- `runs.projectId` NOT NULL FK → `projects(id)` (cascade).
- `runs` idempotency index changed from unique on `idempotencyKey` to unique
  on `(projectId, idempotencyKey)` — two tenants must not collide on a CI
  build id.
- Replaced `(repo, createdAt)` index on runs with `(projectId, createdAt)`.

Derived tables (`testResults`, `testTags`, `testAnnotations`, `artifacts`)
have no new columns — scope flows via the run join.

### Migration strategy

Wrightful is pre-production, so rather than stacking a second migration the
initial one was regenerated from scratch:

1. Deleted `packages/dashboard/drizzle/0000_neat_silver_fox.sql` and
   `drizzle/meta/`.
2. Wiped `.wrangler/state` to reset local D1.
3. `pnpm --filter @wrightful/dashboard db:generate` →
   `0000_odd_gamma_corps.sql` with the full multi-tenant schema.
4. `pnpm db:migrate:local` → clean apply (35 statements).

No seed — the first user who signs up creates their own first team and
project via the admin UI.

### Auth (Better Auth)

`packages/dashboard/src/lib/better-auth.ts`:

- `getAuth()` factory, cached per worker instance.
- ULID generator wired via `advanced.database.generateId` so Better Auth
  rows use the project's id convention.
- `emailAndPassword: { enabled: true, requireEmailVerification: false }` —
  self-hosters need only `BETTER_AUTH_SECRET` to sign up.
- GitHub OAuth is only registered as a social provider when both
  `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set. The login page
  hides the "Continue with GitHub" button accordingly via
  `hasGithubOAuthConfigured()`.
- Throws a clear startup error if `WRIGHTFUL_PUBLIC_URL` or
  `BETTER_AUTH_SECRET` are missing — no silent degradation.

`packages/dashboard/src/routes/auth.ts` — catch-all at `/api/auth/*`
delegates to `auth.handler`. Mounted **before** the bearer-token
`prefix("/api", […])` block so the API-key middleware doesn't run.

`packages/dashboard/src/routes/middleware.ts`:

- `loadSession` — reads the Better Auth session cookie onto ctx. Errors
  from `getAuth()` intentionally aren't swallowed (a missing secret
  surfaces as a 500 rather than an infinite redirect to `/login`).
- `requireUser` — calls `loadSession` then redirects to `/login?next=…`
  when `ctx.user` is absent.

`packages/dashboard/src/lib/authz.ts` — `getTeamRole`,
`resolveTeamBySlug`, `resolveProjectBySlugs`. Each verifies membership in
the same query that resolves the row so callers can 404 on "doesn't exist
OR no access" uniformly.

### Query scoping

Every read that touches `runs` or derived tables filters by `projectId`:

- `src/routes/api/ingest.ts` — idempotency check scoped to
  `(projectId, idempotencyKey)`; new runs get `projectId` from
  `ctx.apiKey.projectId`.
- `src/routes/api/artifacts.ts` — presign verifies `runs.projectId`
  matches the caller's key before checking testResultId ownership.
  Prevents cross-tenant presigning via ULID guessing.
- `src/app/pages/runs-list.tsx`, `run-detail.tsx`, `test-detail.tsx`,
  `test-history.tsx` — resolve the active project via
  `getActiveProject()` (reads `:teamSlug`/`:projectSlug` params + user
  membership) and add `eq(runs.projectId, project.id)` to every query.
- `src/routes/api/artifact-download.ts` — still gated by the unguessable
  artifact ULID. The `TODO(phase5)` comment still applies; project-scoped
  signed tokens remain the Phase 5 follow-up.

### Routes

All dashboard routes sit under `render(Document, [loadSession, …])`. Every
page except `/login` is wrapped in `requireUser`.

- `/login` — email+password form (sign-in / sign-up toggle), with an
  optional "Continue with GitHub" button when the OAuth secrets are set.
- `/` → team picker (auto-redirects if exactly one team, shows empty state
  with "Create a team" for first-time users).
- `/t/:teamSlug` → project picker.
- `/t/:teamSlug/p/:projectSlug[...]` → RunsList / RunDetail / TestDetail /
  TestHistory.
- `/admin/teams`, `/admin/teams/new` (GET+POST),
  `/admin/t/:teamSlug`,
  `/admin/t/:teamSlug/projects/new` (GET+POST),
  `/admin/t/:teamSlug/p/:projectSlug/keys` (GET+POST).

API-key mint/revoke UI lives on the project-keys page. Minting shows the
raw key once (stored only as SHA-256 hash + 8-char prefix).

### Env / wrangler

`packages/dashboard/wrangler.jsonc`:

- Added `WRIGHTFUL_PUBLIC_URL: ""` var.
- Documented two new required secrets and two optional ones.

`packages/dashboard/types/env.d.ts` widened with the new var and the three
auth secrets (`BETTER_AUTH_SECRET` required, GitHub pair optional).

New `.dev.vars.example` at `packages/dashboard/.dev.vars.example` shows
self-hosters the minimum set. `.dev.vars` added to `.gitignore`.

### Small helpers / utilities added

| File                                                  | Purpose                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/lib/active-project.ts`                           | Resolves the project from route params + membership for the current RSC page render |
| `src/lib/authz.ts`                                    | Team/project access helpers                                                         |
| `src/lib/better-auth.ts`                              | Better Auth factory + `hasGithubOAuthConfigured()`                                  |
| `src/lib/form.ts`                                     | `readField()` — type-safe `FormData.get` that returns `""` for non-string values    |
| `src/routes/auth.ts`                                  | Better Auth catch-all mount                                                         |
| `src/routes/middleware.ts`                            | `loadSession`, `requireUser`                                                        |
| `src/app/pages/not-found.tsx`                         | Shared 404 shell used by scope-check failures                                       |
| `src/app/pages/login.tsx`                             | Email+password form + optional GitHub button                                        |
| `src/app/pages/team-picker.tsx`, `project-picker.tsx` | On-login landing pages                                                              |
| `src/app/pages/admin/*.tsx`                           | Team/project/keys admin                                                             |

### Tests

- `src/__tests__/middleware.test.ts` — `requireAuth` asserts that
  `projectId` propagates onto `ctx.apiKey`.
- `src/__tests__/artifacts.test.ts` — DB mock rewritten to return the
  run-ownership row for the new project scoping check. New test covers
  the 404 path when the run doesn't belong to the caller's project. All
  existing cases now pass an `AUTH_CTX` with a valid `apiKey.projectId`.

## Verification

| Check                                          | Result                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @wrightful/dashboard typecheck` | ✅                                                                                                                                                               |
| `pnpm lint`                                    | ✅ (8 pre-existing warnings in cli/api-client, 0 errors)                                                                                                         |
| `pnpm format`                                  | ✅                                                                                                                                                               |
| `pnpm test` (cli + dashboard)                  | ✅ 83 + 45 = 128 tests                                                                                                                                           |
| `pnpm db:migrate:local`                        | ✅ 35 statements applied                                                                                                                                         |
| Ingest + scope smoke test (ran during draft)   | Inserted API key, POSTed a payload to `/api/ingest`, got 201, verified `runs.project_id` matches the owning project, and run rendered on the scoped project page |

## Setting it up

Local:

1. `cp packages/dashboard/.dev.vars.example packages/dashboard/.dev.vars`
2. Fill `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
3. `pnpm --filter @wrightful/dashboard db:migrate:local`
4. `pnpm dev` → visit `http://localhost:5173/` → create an account →
   make a team → make a project → mint an API key.

Production:

- `wrangler secret put BETTER_AUTH_SECRET`
- Set `WRIGHTFUL_PUBLIC_URL` in `wrangler.jsonc` (or via CI overrides).
- Optionally `wrangler secret put GITHUB_CLIENT_ID` /
  `GITHUB_CLIENT_SECRET` — the GitHub OAuth app callback URL is
  `${WRIGHTFUL_PUBLIC_URL}/api/auth/callback/github`.

## Post-review fixes

Two issues flagged in code review and addressed in-place:

- **API-key reveal no longer flows through the URL.** The POST /keys handler
  previously redirected to `?key=<raw>`, leaking the bearer credential into
  the `Location` header, browser URL bar / history, and any access logs in
  front of the Worker. Replaced with a short-lived `HttpOnly; Secure;
SameSite=Lax; Max-Age=60` cookie scoped to the keys page path
  (`wrightful_reveal_key`). The GET page reads the cookie, renders the key
  once, and clears it via `Max-Age=0` on the same response.
- **Unauthorized RSC pages now return HTTP 404.** `NotFoundPage` mutates
  `requestInfo.response.status = 404`, so every page that bails with
  `<NotFoundPage />` (runs-list, run-detail, test-detail, test-history,
  team-picker, project-picker, and the admin surfaces) now matches the
  API-side 404 behaviour and the documented "404 shell" contract in
  `active-project.ts`.

## Out of scope (noted for later)

- **Email invitations.** Requires an email provider. Memberships can still
  be inserted directly by an owner via the UI when an invitee already
  has an account, but there's no invite-by-email flow.
- **Email verification / password reset.** Disabled until an email
  provider is wired up.
- **Per-project roles.** Current model is a single `owner`/`member` role
  per team; per-project admin/editor/viewer distinctions are deferred.
- **Signed-token auth for artifact downloads.** The `TODO(phase5)` comment
  in `artifact-download.ts` is still open.
- **Subdomain routing.** Rejected in favour of path prefixes.
