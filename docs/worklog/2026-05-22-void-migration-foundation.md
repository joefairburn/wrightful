# 2026-05-22 — Void migration foundation (`packages/dashboard-void`)

## What changed

New parallel package `packages/dashboard-void` that ports the rwsdk
dashboard onto [Void](https://void.cloud) — Cloudflare's fullstack Vite
plugin + deploy platform. The old `packages/dashboard` is **untouched**
and stays live until cutover; the new package is greenfield-shaped and
will fully replace it once data migration is done.

Architecture changes baked into the new package:

| Layer      | Old (rwsdk dashboard)                                    | New (dashboard-void)                                                   |
| ---------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime    | `@cloudflare/vite-plugin` + `rwsdk/worker`               | `void` + `voidPlugin()` + `@void/react`                                |
| Routing    | `defineApp([...])` w/ rwsdk router DSL                   | File-based `routes/` + `pages/` + co-located `*.server.ts`             |
| DB         | `ControlDO` (singleton) + `TenantDO` (per-team) + Kysely | Single D1 + Drizzle (`void/db`, schema in `db/schema.ts`)              |
| Tenancy    | Physical: per-team DO instance                           | Logical: every run-scoped query MUST filter by `teamId AND projectId`  |
| Auth       | Better Auth + KV session store                           | Void auth (Better Auth under the hood, D1-backed sessions)             |
| API keys   | Bearer key in SHA-256/prefix lookup table                | Same scheme, ported as route middleware                                |
| Realtime   | `SyncedStateServer` DO + `useSyncedState` rooms          | `void/live` topic `run:<runId>` (DO-backed fanout with per-topic auth) |
| Artifacts  | R2 binding + signed-token download                       | `void/storage` + same signed-token approach                            |
| Cron       | `*/5 * * * *` watchdog with per-team RPC fanout          | Single D1 UPDATE in `crons/sweep-stuck-runs.ts`                        |
| Env vars   | `.dev.vars` + `worker-configuration.d.ts`                | `env.ts` with `defineEnv({...})` from `void/env`                       |
| Migrations | rwsdk DSL self-applying on DO cold start                 | Drizzle SQL files in `db/migrations/`, applied on deploy               |

## Details

### Configuration

| File             | Purpose                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `package.json`   | Void deps (`void`, `@void/react`), drops `rwsdk`/`kysely`/`wrangler`/`@cloudflare/vite-plugin`        |
| `vite.config.ts` | `voidPlugin()` + `voidReact()` + Tailwind v4 + babel react-compiler                                   |
| `void.json`      | Auth providers (`email`, `github`), worker compat date, security headers                              |
| `env.ts`         | All env keys typed via `defineEnv({...})`; secrets marked `.secret()`                                 |
| `tsconfig.json`  | Extends `.void/tsconfig.json`; paths for `@schema`, `@/*`, `void/db`, `void/routes`                   |
| `auth.ts` (root) | Custom `defineAuth({...})` with ULID ids, GitHub login capture hook, email auth (no verification yet) |

### Database

Single D1 schema at `db/schema.ts`. Better Auth core tables
(`user`/`session`/`account`/`verification`) are intentionally NOT declared —
void's auth migrator bootstraps them idempotently against the same DB and we
join via raw SQL when needed.

Our tables:

- **Tenancy**: `teams`, `projects`, `memberships`, `teamInvites`, `userGithubAccounts`, `userState`
- **API keys**: `apiKeys` (project-scoped Bearer tokens)
- **Runs**: `runs` (with denormalized `teamId` for indexed team-scope filtering)
- **Run children**: `testResults`, `testTags`, `testAnnotations`, `testResultAttempts`, `artifacts`
  - Every child table carries `projectId` so the brand-typed `TenantScope`
    (in `src/lib/scope.ts`) gates access without runtime joins.

### Auth surface

- Void manages the `/api/auth/*` mount. Email/password + GitHub OAuth via
  `void.json#auth.providers`. Provider creds come from `AUTH_GITHUB_CLIENT_ID`
  / `AUTH_GITHUB_CLIENT_SECRET`.
- `auth.ts` extends defaults with ULID ids and a post-create hook that mirrors
  the GitHub login into `userGithubAccounts` (Better Auth only stores the
  numeric `accountId`).
- Server helpers: `getSession()` and `getUser()` (sync) from `void/auth`;
  `requireAuth(c)` (sync) for gated routes.
- API key middleware: `src/lib/api-auth.ts#requireApiKey` validates the
  `Authorization: Bearer …` header, looks up by 8-char prefix, hash-compares
  the rest, populates `c.var.apiKey`.

### Routes (HTTP API)

All in `routes/`:

| Endpoint                                         | Purpose                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `POST /api/runs`                                 | Open a streaming run (idempotent on idempotencyKey)           |
| `POST /api/runs/:id/results`                     | Append a batch of test results + recompute aggregates         |
| `POST /api/runs/:id/complete`                    | Finalize a run with terminal status                           |
| `POST /api/artifacts/register`                   | Reserve rows + return presigned upload URLs                   |
| `PUT  /api/artifacts/:id/upload`                 | Stream body into R2                                           |
| `GET/HEAD /api/artifacts/:id/download?t=<token>` | Token-authed artifact stream (signed with BETTER_AUTH_SECRET) |
| `POST /api/user/last-team`                       | Persist user's last-viewed team                               |
| `POST /api/user/last-project`                    | Persist user's last-viewed project                            |
| `POST /api/invites/:inviteId/accept`             | Resolve a directed invite + create membership                 |
| `POST /api/invites/:inviteId/decline`            | Delete an invite                                              |
| `GET / POST /live`                               | `void/live` WS connect + HTTP control endpoints               |

The ingest pipeline (`src/lib/ingest.ts`) is a Drizzle/D1 port of the rwsdk
version. Same atomicity (D1 `batch` runs every statement in a single
transaction), same chunking (≤99 params per statement), same aggregate-delta
algorithm (avoids a 5-subquery recompute on every batch), same realtime push
shape — only the storage backend and broadcast transport changed.

### Realtime

`src/live.ts` defines a single `defineLiveStream({ id: "app", ... })` with:

- `identifyConnection`: ties the WS to a void-auth session, anonymous allowed
- `onSubscribe`: per-topic auth — `run:<runId>` requires team membership for
  that run (single SQL: `runs ⋈ memberships`)
- `publishRunUpdate(runId, event)`: exported helper; ingest handlers call it
  after every successful write

Topic taxonomy: `run:<runId>` is the only topic so far; runId is globally
unique (ulid) so no team/project disambiguator needed.

### Pages

Minimal port — enough to demonstrate the wiring works. Pages live in
`pages/` with co-located `*.server.ts` loaders. Layout shell is
`pages/layout.tsx` (imports global styles).

Ported pages:

| Path                          | File                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `/`                           | `pages/index.{tsx,server.ts}` — team picker + post-login auto-redirect |
| `/login`                      | `pages/login.{tsx,server.ts}` — email + GitHub                         |
| `/t/:teamSlug`                | `pages/t/[teamSlug]/index.{tsx,server.ts}` — project picker            |
| `/t/:teamSlug/p/:projectSlug` | `pages/t/[teamSlug]/p/[projectSlug]/index.{tsx,server.ts}` — runs list |

### UI components

All 54 wrappers in `src/components/ui/` copied verbatim from the old
dashboard. Patches:

- Stripped `"use client"` directives (Void pages are isomorphic by default)
- Rewrote `@/app/components/...` imports to `@/components/...`

The components are pure Base UI + Tailwind + `cn()` so no logic changes
needed.

### Cron

`crons/sweep-stuck-runs.ts` — `*/5 * * * *` watchdog marks runs at
`status='running'` older than `WRIGHTFUL_RUN_STALE_MINUTES` as
`'interrupted'`. Single D1 UPDATE (the per-team fanout was a DO artifact).

### Middleware

`middleware/01.context.ts` — resolves the active team + project + sibling
lists in one SQL when the URL matches `/t/:teamSlug[/p/:projectSlug]/...`,
stashes on `c.var`. Augments `CloudContextVariables` with `userTeams`,
`activeTeam`, `teamProjects`, `activeProject`.

## What's NOT done (follow-up work)

This worklog covers the **foundation**: auth, schema, ingest contract,
realtime, and a minimal pages tree that proves the wiring is sound.
Feature-parity follow-ups:

### Pages still to port (from `packages/dashboard/src/app/pages/`)

- `run-detail.tsx` (heavy — needs realtime hook + tests table + grouping)
- `test-detail.tsx` (attempts tabs + artifacts rail + visual diff)
- `flaky-tests.tsx`, `slowest-tests.tsx`, `tests.tsx`, `insights.tsx`,
  `suite-size.tsx`, `run-duration.tsx` (analytics — visx charts + bucketing)
- `invite.tsx`, `team-picker.tsx`, `project-picker.tsx`
- All `settings/*` pages: profile, team-new, team-detail, project-new,
  project-keys
- `signup` route (gated on `ALLOW_OPEN_SIGNUP`)

### API endpoints still to port (read paths used by the dashboard)

- `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/summary`
- `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/results`
- `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/summary`
- `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview`

These are pure read endpoints called from client hooks; they can live in
`routes/api/...` once the relevant pages need them. Until then the page
loaders can query D1 directly via `void/db`.

### Components still to port

From `packages/dashboard/src/app/components/`:

- `app-layout.tsx` (sidebar + header shell)
- `sidebar-user-menu.tsx`, `team-switcher.tsx`, `project-switcher.tsx`
- `run-history-chart.tsx`, `duration-chart.tsx`, `sparkline.tsx`,
  `run-progress.tsx` (visx-based)
- `runs-filter-bar.tsx`, `filter-controls.tsx`,
  `run-history-branch-filter.tsx` (nuqs filter state)
- `artifacts-rail.tsx`, `artifact-actions.tsx`, `visual-diff-dialog.tsx`
- `attempt-tabs.tsx`, `flaky-test-row.tsx`, `test-error-alert.tsx`,
  `run-tests-popover.tsx`
- `analytics/*` (kpi-card, line-chart, bucket-bar-chart, etc.)
- `query-provider.tsx` if we keep TanStack Query for client-side refreshes
  (most cases can now use loader re-run via `router.refresh()`)

### Lib helpers still to port

- `src/lib/analytics/{bucketing,range}.ts` (depended on kysely; rewrite vs Drizzle)
- `src/lib/group-tests-by-file.ts` (depended on rwsdk progress import)
- `src/lib/runs-filters.ts` (nuqs filter state for the runs list)
- `src/lib/branches-query.ts` (port to Drizzle)
- `src/lib/test-artifact-actions.ts` (port to Drizzle + void/storage)
- `src/lib/route-params.ts` (typed params — can lean on Void's typed routes now)
- `src/lib/form.ts` (replace with `@void/react`'s `useForm`)

### Tests

- Port unit tests from `packages/dashboard/src/__tests__/` (~38 files). Most
  need rewrites due to Kysely → Drizzle, removal of DO mocks, and the
  shift from rwsdk router context to Hono.
- Integration tests (`vitest-pool-workers`) need to be reconfigured for
  Void; the wrangler runtime details no longer apply.

### Rate limiting

The rwsdk version used 3 Cloudflare native rate limiters (`AUTH_RATE_LIMITER`,
`API_RATE_LIMITER`, `ARTIFACT_RATE_LIMITER`) declared in `wrangler.jsonc`.
Void's `void.json#worker` block doesn't accept binding arrays — explicit
binding-id config has to live in a `wrangler.json` fallback. For now the
new package ships without rate limiters; revisit before cutover.

### Data migration

Production dashboards have live data in the ControlDO + per-team TenantDOs.
A separate one-shot ETL script (not in this worklog) will need to export
from those DOs and import into the new D1. Until that's run, dashboard-void
is a fresh database.

### Misc

- `.dev.vars` / secrets: set `BETTER_AUTH_SECRET`, `WRIGHTFUL_PUBLIC_URL`
  via `void secret put` for deploy, or `.env.local` for local dev.
- Drizzle migration generation: run `pnpm db:generate` once schema is
  finalized to produce SQL files in `db/migrations/`.
- The `as never` casts on `db.batch([...])` are pragmatic — Drizzle's batch
  tuple type is awkward to express precisely. Future work could replace
  with `db.batch([head, ...rest] as const)` once Drizzle's types catch up.

## Verification

```bash
pnpm install
cd packages/dashboard-void
pnpm exec void prepare   # generates .void/{routes,db,env}.d.ts and tsconfig
pnpm check                # vp check (format + lint + typecheck) — passes
```

Status as of this commit:

- `void prepare` succeeds (codegen written)
- `vp check` passes: **0 errors, 30 warnings** (mostly `no-unsafe-type-assertion`
  on the pragmatic `as never` casts)
- Build (`vp build`) and dev (`vp dev`) not yet exercised — first run will
  surface any runtime config gaps that the static checks missed.

## Architectural decisions captured here

1. **Single D1 over per-team DOs.** Accepts a single-region writer in exchange
   for cross-team JOINs and one source of truth. Wrightful's write rate
   (single-digit per team per second) makes this trivially fine.
2. **`teamId` denormalized onto `runs`.** Lets team-scoped filters hit an
   index without joining through `projects`. The cost is keeping
   `runs.teamId == projects.teamId` invariant — enforced at insert time by
   `tenantScopeFor*` and immutable thereafter (projects don't move teams).
3. **Better Auth tables stay void-managed.** We declared our own tables
   alongside but skipped declaring `user`/`session`/`account`/`verification`
   to avoid index/column collisions with void's idempotent bootstrap.
   Cross-table joins use raw SQL.
4. **GitHub login captured into `userGithubAccounts`, not Better Auth's
   `account.githubLogin` custom field.** Avoids extending the void-owned
   schema; trade-off is one extra table and one upsert per OAuth sign-in.
5. **Realtime via `void/live` with topic `run:<runId>`.** Replaces the
   stateful `SyncedStateServer` DO. `void/live` is DO-backed internally
   (multi-topic per connection, replay buffer) — closer to a publish-bus
   primitive than a room. Auth gates per-topic in `onSubscribe`.
6. **Pages are isomorphic.** Void's Inertia-style pages mode means no
   `"use client"` boundary. All UI components ported verbatim; the only
   `*.server.ts` files are loader/action modules.
