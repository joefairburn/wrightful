# Architecture

A one-page orientation. For the narrative behind each decision, read the dated entries in [`docs/worklog/`](./worklog/) — they are the project's source of truth for _why_.

## Shape

```
Playwright CI ──@wrightful/reporter──▶ Worker (/api/runs/*)
                                        │
                                        ├─ control D1 ──── auth + tenancy lookup
                                        │
                                        ├─ TenantDO RPC ── writes runs + derived rows
                                        │
                                        └─ R2 (presigned PUT/GET) ── artifact bytes

Browser ────────RSC pages──────────────▶ Worker (/t/:team/p/:project/…)
                                        │
                                        ├─ Better Auth session ── dashboard auth
                                        ├─ control D1 ─────────── teams, projects, memberships
                                        ├─ TenantDO RPC ────────── reads runs + derived rows
                                        └─ SyncedStateServer DO ── realtime progress stream
```

## Storage split

- **Control D1.** One database. Users, teams, projects, memberships, API keys, invites. Accessed via `getDb()` in `packages/dashboard/src/db/index.ts`, which returns a `Kysely<DB>`.
- **Tenant DO** (`class TenantDO`, binding `TENANT`). One instance per team, SQLite-backed. Holds `runs`, `testResults`, `testResultAttempts`, `testTags`, `testAnnotations`, `artifacts`. Reached only through `tenantScopeForUser` / `tenantScopeForApiKey` in `packages/dashboard/src/tenant/index.ts` — both run the auth check, then hand back a `TenantScope` with a `Kysely<TenantDatabase>` `db`, a branded `AuthorizedProjectId`, and a `batch()` for atomic multi-statement writes.
- **R2.** Artifact bytes only. Upload via presigned PUT from the reporter; download via a signed token that carries the R2 key, so GETs don't touch the DB.
- **SyncedStateServer DO** (binding `SYNCED_STATE_SERVER`). Broadcasts progress snapshots while a run is streaming. Ingest handlers call `stub.setState(progress, "progress")` after each DO write; run detail/list islands subscribe via rwsdk's `useSyncedState`.

Tenant migrations live in `packages/dashboard/src/tenant/migrations.ts` and are applied on first access by rwsdk's Database DSL — no CLI step. Only the control D1 has a `wrangler d1 migrations` flow.

## Auth

Two systems coexist on the same worker:

- **Dashboard sessions** — Better Auth over `kyselyAdapter`. Email + password, optional GitHub OAuth. Factory in `src/lib/better-auth.ts`; mounted at `/api/auth/*`. Session middleware (`loadSession`, `requireUser`) lives in `src/routes/middleware.ts`.
- **Ingest API keys** — Bearer tokens, SHA-256 hashed at rest, looked up by 8-char prefix and hash-compared (`src/lib/auth.ts`). Each key is scoped to a single project. Reporter requests also carry `X-Wrightful-Version: 3`; older protocols return 409.

## Routing

- `/` — team picker.
- `/admin/…` — team + project management (create team, create project, invites, API keys).
- `/t/:teamSlug/p/:projectSlug/…` — tenant-scoped UI. Every handler starts with `getActiveProject()` or `tenantScopeForUser(...)` to verify membership.
- `/api/runs/*`, `/api/artifacts/*` — ingest + artifact API. Guarded by `requireAuth` (API key) and `negotiateVersion` (protocol header).

Route composition lives in `packages/dashboard/src/worker.tsx` — rwsdk's `defineApp` with `prefix("/api", [...])` for the API chain and `render(Document, [...])` for RSC pages.

## Frontend

- RSC by default; `"use client"` only at interactive leaves.
- Base UI primitives are wrapped as a local component library in `src/app/components/ui/` (~50 components). Don't import `@base-ui-components/react` directly from page code — go through the wrappers.
- Tailwind v4 with theme tokens in `src/app/styles.css` under `@theme { … }`. No `tailwind.config.*`.
- New components come from the COSS registry (`components.json`): `npx shadcn@latest add @coss/<name>`.
- URL-backed UI state uses `nuqs`; `NuqsAdapter` is mounted globally in `src/app/providers.tsx`.

## Tooling

- Typecheck: `tsgo` (native TS preview).
- Lint: `oxlint`. Format: `oxfmt`. Pre-commit hook (husky + lint-staged) runs `oxlint --fix` + `oxfmt --write` on staged JS/TS.
- Reporter releases: Changesets. `pnpm release` runs from the root; dashboard is deployed separately via Cloudflare, not published.
- IDs: ULIDs for every primary key.
