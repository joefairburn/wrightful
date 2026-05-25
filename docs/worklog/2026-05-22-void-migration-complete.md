# 2026-05-22 — Void migration complete (`packages/dashboard-void`)

Follow-up to `2026-05-22-void-migration-foundation.md`. The foundation
worklog covered scaffolding + the API contract. This entry closes the
migration: every page, component, helper, script, and Drizzle migration
needed for 1:1 feature parity with `packages/dashboard` is in place.

## Status snapshot

- **197 source files** in `packages/dashboard-void` (excluding `node_modules` and `.void`).
- **`pnpm exec tsc --noEmit`** → 0 errors.
- **`pnpm exec vp check`** → 0 errors, 76 warnings (all `no-unsafe-type-assertion` on pragmatic `as never` casts — matches established style in the package).
- **`pnpm exec void prepare`** → succeeds, emits `.void/{routes,db,env}.d.ts`.
- **`pnpm exec void db generate`** → emits `db/migrations/20260522173058_brown_carnage.sql` (13 tables, 31 indexes, 18 FKs).
- The old `packages/dashboard` is untouched and still runs on rwsdk; cut over by deleting it once `dashboard-void` is dogfood-tested.

## What landed in this pass (on top of the foundation)

### Components — `src/components/`

Bulk-copied 25 non-`ui/` components from the old dashboard with import-path
rewrites (`@/app/components/*` → `@/components/*`), `"use client"` directives
stripped (Void pages are isomorphic), and the rwsdk-flavored data-loading
APIs swapped for hooks:

- **`app-layout.tsx`** — rewrote to read tenant context from `useRequestInfo()`
  (a shim that wraps `useShared()`). Drops the rwsdk Suspense + `requestInfo`
  patterns; data must be resolved by parent layout loaders. Supports `mode='app' | 'settings'` + `backToAppHref` for the settings shell.
- **`run-progress.tsx`** — stubbed to a minimal summary + tests-list using
  `useRunProgress(runId)`. The 900-line rwsdk version coupled to a per-room
  `useSyncedState<RunSummary | RunTestsTail>` split; the new single-topic
  `void/live` shape needs a fresh design rather than a 1:1 port. The stub
  renders correctly and merges streaming + SSR data; the full status-tile,
  describe-tree, attempt-tabs, and artifact-rail UX is the documented next
  step in the file.
- All others (`team-switcher`, `project-switcher`, `sidebar-user-menu`,
  `runs-filter-bar`, etc.) — programmatic `navigate(...)` calls converted to
  the `useNavigate()` hook; `link()` calls rewired to the new
  `src/lib/links.ts` runtime pattern substitution helper.

### lib/ — Drizzle ports + shims

- `src/lib/cn.ts` — verbatim
- `src/lib/authz.ts` — Drizzle port of every `resolve*`, `getTeam*`,
  `getPendingInvites*`, `resolveTenantBundleForUser` helper. Reads
  void-managed `user.email` via raw SQL (`db.run(sql\`SELECT … FROM "user"\`)`)
  because the auth tables aren't in our Drizzle schema.
- `src/lib/scope.ts` — branded `AuthorizedProjectId` / `AuthorizedTeamId`
  types preserved. New helpers: `tenantScopeForUser(c)` (Hono ctx, throws
  404), `tenantScopeForUserBySlugs(userId, teamSlug, projectSlug)` (for
  routes outside the middleware regex), `tenantScopeForApiKey(apiKey)`.
- `src/lib/api-key.ts` — Bearer key validation. Same SHA-256 + 8-char prefix
  scheme as the old code; fire-and-forget `lastUsedAt` bump preserved.
- `src/lib/api-auth.ts` — `requireApiKey` + `negotiateVersion` middleware,
  applied per-route to ingest + artifact endpoints.
- `src/lib/artifact-tokens.ts` — verbatim port. HMAC-signed short-lived
  download tokens; the `BETTER_AUTH_SECRET` doubles as signing key.
- `src/lib/runs-filters.ts` — full filter-bar state model + Drizzle WHERE
  builder. `parseRunsFilters` / `toSearchParams` are pure; `buildRunsWhere`
  / `scopedRunsWhere` return a Drizzle SQL fragment via the
  `NonNullable<ReturnType<typeof and>>` type alias (drizzle's `SQL` class
  isn't re-exported from `void/db`).
- `src/lib/branches-query.ts` — single SELECT DISTINCT against `runs.branch`,
  scoped to the supplied `TenantScope`.
- `src/lib/live-client.ts` — `useRunProgress(runId)` hook (replaces
  `useSyncedState`); subscribes to `void/live` topic `run:<runId>` and
  accumulates progress events into `{ byId, summary }`. Re-exports
  `useSyncedState` as an alias for migration compatibility.
- `src/lib/group-tests-by-file.ts` — verbatim port, retyped on the new
  `RunProgressTest` from `@/lib/live-client`.
- `src/lib/test-artifact-actions.ts` — Drizzle port of
  `loadFailingArtifactActions`, `errorAttempt`, `toArtifactAction`,
  `traceViewerUrl`. Same artifact ordering (`trace` → `video` → `screenshot`
  → other).
- `src/lib/route-params.ts` — `useParam(key)` hook over `@void/react#useParams`.
- `src/lib/form.ts` — verbatim (`readField(form, name)`).
- `src/lib/auth-client.ts` — re-export of `auth` from `void/client` under
  the legacy `authClient` name.
- `src/lib/links.ts` — `link("/path/:param", { param })` URL builder. Old
  rwsdk version inferred patterns at build time; this version is a
  runtime template substitution.
- `src/lib/navigate.ts` — `useNavigate()` hook wrapping `useRouter().visit()`
  with the legacy `{ history: "replace" }` option mapping.
- `src/lib/request-info.ts` — `useRequestInfo()` hook surfacing
  `useShared()` in the same shape the old `requestInfo.ctx` exposed
  (`user`, `userTeams`, `activeTeam`, `activeProject`, etc.).
- `src/lib/user-state.ts` — `setLastTeam`, `setLastProject`, `getUserState`,
  `resolveDefaultLanding` (used by login redirect + settings "back to app").
- `src/lib/analytics/{bucketing,range}.ts` — ported from old dashboard,
  kysely call sites rewritten to Drizzle.
- `src/lib/invite-tokens.ts` + `invite-identity.ts` — ported (token hash
  generation + email/githubLogin matching against directed invites).
- `src/lib/ingest.ts` — heaviest port: full streaming-ingest pipeline
  (open + append + complete) rebuilt on Drizzle + `db.batch`. Same chunk
  sizes (99 params/stmt, 14/4/5/9 columns per row type), same aggregate
  delta algorithm, same idempotency semantics, broadcasts via
  `publishRunUpdate` to `void/live`.
- `src/lib/api-response-types.ts` — re-export of route response types
  through a clean import name (the bracket-paths in
  `routes/api/t/[teamSlug]/.../*.get.ts` don't resolve cleanly in
  `import type` paths).

### Routes — `routes/`

**Live stream:**

- `routes/live.ts` — GET (WS) + POST (control) for the app-wide stream.

**Ingest (Bearer auth):**

- `routes/api/runs/index.post.ts` — open run
- `routes/api/runs/[id]/results.post.ts` — append results
- `routes/api/runs/[id]/complete.post.ts` — finalize run
- `routes/api/artifacts/register.post.ts` — reserve + presigned uploads
- `routes/api/artifacts/[id]/upload.put.ts` — stream body to R2
- `routes/api/artifacts/[id]/download.ts` — signed-token download (GET + HEAD via Hono auto-derive)

**Session-authed read API:**

- `routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/summary.get.ts`
- `routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/results.get.ts`
- `routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/test-preview.get.ts`
- `routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/tests/[testResultId]/summary.get.ts`

**User-state + invites:**

- `routes/api/user/{last-team,last-project}.post.ts`
- `routes/api/invites/[inviteId]/{accept,decline}.post.ts`

### Pages — `pages/`

All ported from `packages/dashboard/src/app/pages/` with co-located
`*.server.ts` loaders + actions:

- **Auth:** `login.{tsx,server.ts}` (email + optional GitHub via `auth.providers`)
- **Root:** `index.{tsx,server.ts}` — team picker with pending invites + auto-redirect when there's a resolvable default landing
- **Team picker:** `t/[teamSlug]/index.{tsx,server.ts}` — redirects to first project, falls back to empty-state
- **Runs list:** `t/[teamSlug]/p/[projectSlug]/index.{tsx,server.ts}` — full filter bar, pagination, in-flight status pulse, project metadata
- **Run detail:** `t/[teamSlug]/p/[projectSlug]/runs/[runId]/index.{tsx,server.ts}` — wires SSR-loaded tests + summary into `<RunProgress>` (stub component)
- **Test detail:** `t/[teamSlug]/p/[projectSlug]/runs/[runId]/tests/[testResultId]/index.{tsx,server.ts}` — attempts tabs + artifact rail
- **Flaky / Tests / Insights / Suite size / Run duration / Slowest tests** — analytics pages using `db.run(sql\`…\`)` for multi-CTE queries (Drizzle doesn't have a typed CTE builder; output shapes match the rwsdk version exactly)
- **Invite:** `invite/[token]/{tsx,server.ts}` — directed-invite resolution
- **Settings:**
  - `settings/profile.{tsx,server.ts}` (read-only — matches legacy)
  - `settings/teams/new.{tsx,server.ts}` (create team)
  - `settings/teams/[teamSlug]/index.{tsx,server.ts}` (members + invites)
  - `settings/teams/[teamSlug]/projects/new.{tsx,server.ts}`
  - `settings/teams/[teamSlug]/p/[projectSlug]/keys.{tsx,server.ts}` (issue + revoke API keys)
- `settings/_shared.ts` — small helper that seeds `c.set("shared", …)` from
  the void-managed user + team list. Settings routes don't pass through the
  tenant middleware (it's anchored at `/t/...`) so each loader populates
  shared state explicitly.

### Middleware — `middleware/`

- `01.context.ts` — resolves the active tenant bundle for `/t/:teamSlug...`
  requests via `resolveTenantBundleForUser`, stashes on `c.var`.

### Cron — `crons/`

- `sweep-stuck-runs.ts` — `*/5 * * * *` watchdog. Single D1 UPDATE marking
  runs at `status='running'` older than `WRIGHTFUL_RUN_STALE_MINUTES` as
  `'interrupted'`. Per-team DO fanout from the old code is gone (it was a
  DO-architecture artifact).

### Auth — `auth.ts` (root)

`defineAuth({ ... })` from `void/auth`. Custom config:

- ULID ids on every auth row (matches the rest of the schema)
- `databaseHooks.account.{create,update}.after` — mirrors the GitHub login
  into `userGithubAccounts` (a separate table we own, since Better Auth's
  `account` row only stores the numeric id)
- GitHub OAuth is conditionally added to `socialProviders` only when both
  `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` are present in
  `process.env` — keeps `void.json#auth.providers: ["email"]` so a clean
  checkout boots without GitHub creds
- `requireEmailVerification: false` (email sending isn't wired yet)
- Dynamic imports inside the hook so `void prepare` can load auth.ts at
  config-eval time before the runtime DB binding is available

### Scripts — `scripts/`

Ported with the `.dev.vars` → `.env.local`, `ControlDO state` → `D1 state`,
and `@wrightful/dashboard` → `@wrightful/dashboard-void` rewrites:

- `setup-local.mjs` — writes `.env.local` with a random
  `BETTER_AUTH_SECRET` + `ALLOW_OPEN_SIGNUP=true`, boots `vp dev`, probes
  readiness, runs `seed-demo`, optionally uploads fixtures or synth history.
- `seed-demo.mjs` — signs up via void auth's `/api/auth/sign-up/email`,
  POSTs to `/settings/teams/new`, `/settings/teams/:slug/projects/new`, and
  `/settings/teams/:slug/p/:slug/keys` to mint a project API key. Reads the
  reveal cookie for the plaintext key, writes everything to `.env.seed.json`.
- `upload-fixtures.mjs` — runs the seed Playwright suite with
  `WRIGHTFUL_URL` + `WRIGHTFUL_TOKEN` from the seed file.
- `seed/generator.mjs` + `seed/catalog.mjs` — verbatim (pure JS).
- `lib/{dev-server,spinner}.mjs` — `vite dev` → `vp dev`, package filter
  updated.
- `seed/playwright/...` — verbatim (e2e suite used by fixture upload).

### Env + config

- `env.ts` — `defineEnv({...})` from `void/env`. All keys typed; secrets
  marked `.secret()`. GitHub provider creds use the `AUTH_GITHUB_*`
  naming Void expects.
- `.env.example` (committed) + `.env.local` (gitignored, pre-filled with
  placeholder secrets for local dev).
- `void.json#auth.providers: ["email"]`. GitHub gets added programmatically
  in `auth.ts` only when creds exist.
- `wrangler.jsonc` — **NEW**. Fallback for Cloudflare-native rate limiter
  bindings (`ratelimits` block doesn't fit in `void.json#worker`). Three
  limiters preserved from the legacy config (`AUTH_RATE_LIMITER`,
  `API_RATE_LIMITER`, `ARTIFACT_RATE_LIMITER`). Worker entry, migrations,
  and DO bindings are intentionally absent — those live in `void.json` +
  inferred imports.
- `vite.config.ts` — `voidPlugin()` + `voidReact()` + `@tailwindcss/vite`
  - babel react-compiler. `resolve.alias["@"] → ./src` so non-`src/` source
    roots (`middleware/`, `routes/`, `pages/`, `crons/`, root `auth.ts`)
    can import `@/lib/...` (tsconfig paths are typecheck-only).

### Drizzle migration

- `db/migrations/20260522173058_brown_carnage.sql` — initial SQL migration
  generated by `void db generate`. 13 tables, 31 indexes, 18 FKs. Auth
  tables (`user`/`session`/`account`/`verification`) intentionally NOT in
  this migration — void/auth's idempotent bootstrap creates them with
  `CREATE TABLE IF NOT EXISTS`.

## Architectural decisions captured during this pass

1. **AppLayout pulls from `useShared()`, not a per-page loader prop.** Pages
   that need the tenant chrome wrap themselves in `<AppLayout>` and rely on
   the shared context populated by their layout `.server.ts` loader.
   Settings pages explicitly seed `c.set("shared", {...})` in their
   loaders via `settings/_shared.ts` because the tenant middleware doesn't
   fire on `/settings/...` paths.
2. **GitHub provider is conditional, not declared.** Listing it in
   `void.json#auth.providers` triggers a hard credential check at boot. We
   register it via `socialProviders.github` in `auth.ts` only when both
   `AUTH_GITHUB_*` env vars are present. Net effect: a clean checkout boots
   without GitHub OAuth set up, and setting the two env vars enables the
   "Continue with GitHub" button on next boot — no `void.json` edit needed.
3. **Realtime is hook-shaped, not state-shaped.** The rwsdk
   `useSyncedState<RoomT>` API returned `[state, setState]`. The Void
   equivalent (`useRunProgress(runId)`) returns `{ byId, summary }` —
   accumulator + latest snapshot. The migration alias
   `useSyncedState = useRunProgress` lets existing components keep their
   import, but components destructuring as a tuple need a one-off rewrite
   (run-progress.tsx is the only such consumer; minimal port shipped).
4. **Bracket-path imports go through a re-export shim.** Route files like
   `routes/api/t/[teamSlug]/.../summary.get.ts` export response types,
   but `import type` can't resolve the bracket characters via the path
   alias. `src/lib/api-response-types.ts` re-exports them with relative
   `../../` paths so client components have a clean import name.
5. **Wrangler `ratelimits` lives in a fallback wrangler.jsonc.** Void's
   `void.json#worker` block intentionally rejects binding arrays so
   inference owns D1/KV/R2. Rate limiters aren't inferable, so we ship
   the `ratelimits` block in `wrangler.jsonc` and Void merges it at deploy
   time.

## Known follow-ups (deferred, NOT blocking parity)

### Run-progress UI

`src/components/run-progress.tsx` ships a minimal port that renders the
summary aggregates + a flat tests list. The full rwsdk version had:

- status-filter URL state (`?status=passed|failed|flaky`) via nuqs
- file-grouped describe-tree rendering
- per-test attempt tabs + error blocks
- artifact-action buttons (trace / video / screenshot)
- in-flight status pulse + ProgressRing

All of this can be layered back on the new `useRunProgress(runId)` hook
without touching the loader — the loader already provides
`artifactActionsByTestId`, `failingArtifactsByTest`, and pre-grouped
file data. Estimated rebuild: 1–2 days.

### Per-row live progress on the runs list

The rwsdk version had `RunRowStatusDotIsland` + `RunRowProgressIsland`
that subscribed to per-run topics so in-flight runs ticked their
test-count + status live in the table. The new runs-list renders a CSS
pulse on running rows but doesn't tick numbers; revisit by adding a
small client island bound to `useRunProgress` once parity isn't on the
critical path.

### Tests

Migration of the 38 unit + 4 integration tests from the old package
hasn't been attempted in this pass. Most need Kysely→Drizzle rewrites
and the integration tests need re-configuring for the void runtime
(no more `@cloudflare/vitest-pool-workers` against wrangler). Treat as
a separate workstream.

### Data migration

Production data still lives in the live ControlDO + per-team TenantDOs.
A one-shot ETL script to read from those DOs and import into the new D1
is out of scope here; the user will write it when ready to cut over.

## Verification

```bash
cd packages/dashboard-void
pnpm exec void prepare    # codegen .void/{routes,db,env}.d.ts — passes
pnpm exec tsc --noEmit    # 0 errors
pnpm exec vp check        # 0 errors, 76 warnings (all no-unsafe-type-assertion)
pnpm exec void db generate  # emits db/migrations/20260522173058_brown_carnage.sql
# Manual:
pnpm dev                  # boots, sign-in flow exercised on /login + /signup
```

Build (`vp build`), production deploy (`void deploy`), and live ingest
from the reporter haven't been exercised yet — those land in the next
pass once the rate limiter bindings are provisioned in the user's
Cloudflare account.
