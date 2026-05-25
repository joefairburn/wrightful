# 2026-05-22 — Typed fetch migration + latent route-routing bug fix

Follow-up to `2026-05-22-void-audit-tightening.md`. Addressed the post-audit
findings flagged in review: switch client fetches to `void/client`, add
query validators to read-API routes, fix the `lastUsedAt` fire-and-forget,
clean up `as any` casts in auth hooks, and remove the now-unused
`WRIGHTFUL_PUBLIC_URL` env var.

The typed-fetch migration surfaced two latent bugs that this pass fixes.

## Changes

### Latent bug A — `lastTeam` / `lastProject` schema mismatch

The dashboard-void routes accepted `{ teamId, projectId }` (ids), but the
team-/project-switcher components were sending `{ teamSlug, projectSlug }`.
The old (rwsdk) handlers took slugs and resolved to ids server-side; the
new routes silently regressed.

Fix: route handlers now accept slugs and resolve to ids server-side via
`resolveTeamBySlug` / `resolveProjectBySlugs`, matching the legacy
behaviour and the client's call shape.

- `routes/api/user/last-team.ts`
- `routes/api/user/last-project.ts`

### Latent bug B — Method-suffixed route filenames mounted at `.get` / `.post`

Void@0.8.9's `parsePath` strips only `.dev` / `.prod` env suffixes from
route filenames — **not** `.get` / `.post`. That means
`routes/api/runs/index.post.ts` mounted at `POST /api/runs/index.post` (with
the `.post` suffix in the URL), but the seed scripts + client components
were calling `/api/runs` (no suffix). The migrate-vite-cloudflare-to-void
skill doc claims method-suffix stripping; the impl does not match yet in
0.8.9.

Confirmed at the type level: `RouteMap` keys include the `.get` / `.post`
suffix, so `void/client#fetch("/api/.../summary")` fails to type-check.

Fix: renamed all 13 method-suffixed route files to drop the suffix. Each
file already exported exactly one HTTP method, so the rename is mechanical
and the URLs become clean (`/api/runs`, `/api/user/last-team`, etc.).
Updated the import paths in `src/lib/api-response-types.ts` accordingly.

Renamed (each kept its sole method export):

| Before                                                              | After                                      |
| ------------------------------------------------------------------- | ------------------------------------------ |
| `routes/api/artifacts/[id]/upload.put.ts`                           | `routes/api/artifacts/[id]/upload.ts`      |
| `routes/api/artifacts/register.post.ts`                             | `routes/api/artifacts/register.ts`         |
| `routes/api/invites/[inviteId]/accept.post.ts`                      | `routes/api/invites/[inviteId]/accept.ts`  |
| `routes/api/invites/[inviteId]/decline.post.ts`                     | `routes/api/invites/[inviteId]/decline.ts` |
| `routes/api/runs/[id]/complete.post.ts`                             | `routes/api/runs/[id]/complete.ts`         |
| `routes/api/runs/[id]/results.post.ts`                              | `routes/api/runs/[id]/results.ts`          |
| `routes/api/runs/index.post.ts`                                     | `routes/api/runs/index.ts`                 |
| `routes/api/t/.../runs/[runId]/results.get.ts`                      | `.../results.ts`                           |
| `routes/api/t/.../runs/[runId]/summary.get.ts`                      | `.../summary.ts`                           |
| `routes/api/t/.../runs/[runId]/test-preview.get.ts`                 | `.../test-preview.ts`                      |
| `routes/api/t/.../runs/[runId]/tests/[testResultId]/summary.get.ts` | `.../summary.ts`                           |
| `routes/api/user/last-project.post.ts`                              | `routes/api/user/last-project.ts`          |
| `routes/api/user/last-team.post.ts`                                 | `routes/api/user/last-team.ts`             |

### Typed-fetch migration

Switched the four data-fetching client components to
`import { fetch } from "void/client"`. The typed `fetch` infers paths,
params, body, and response shape from the generated `RouteMap`, so paths
are autocompleted and request/response types come straight from the route
handler. Used the new clean URLs (after the rename above).

- `src/components/team-switcher.tsx` — POST `/api/user/last-team`
- `src/components/project-switcher.tsx` — POST `/api/user/last-project`
- `src/components/run-tests-popover.tsx` — GET `/api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview`
- `src/components/run-history-bar-hover.tsx` — GET run + test-result summary

`fetch(artifact.downloadHref)` calls in `artifact-actions.tsx` and
`artifacts-rail.tsx` stay on the global `fetch` — the URL is a server-built
signed link and the same href is also used as `<img src>` / `<video src>`,
so the typed wrapper would only fit half the use cases.

### Query validator on the runs results read API

`routes/api/t/.../runs/[runId]/results.ts` had manual `url.searchParams.get`
parsing for `status`, `limit`, and `cursor`. Replaced with
`defineHandler.withValidator({ query: z.object({...}) })` — the audit-tightening
pass migrated page loaders to validators but missed this sibling read-API
route. The other three read GETs (summary, test-preview, tests/[id]/summary)
take no query params and stay on plain `defineHandler`.

### Fire-and-forget DB write fixed

`src/lib/api-key.ts#validateApiKey` bumped `lastUsedAt` on the matched API
key row without awaiting. Per saved memory `project_no_fire_and_forget_workers`:
workerd terminates orphaned promises after the response, so the bump could
silently drop under load.

Fix: `validateApiKey` now takes `c: Context` and routes the update through
`c.executionCtx.waitUntil(...)`. The promise lives past the response without
adding latency to the auth path. Callers updated in `src/lib/api-auth.ts`.

### Typed account hooks in `auth.ts`

The `databaseHooks.account.{create,update}.after` chain previously cast
`defaults.databaseHooks?.account?.create as any` and hand-typed the
`account` parameter as a narrow ad-hoc interface. Replaced with types
derived from `VoidAuthConfigContext["defaults"]["databaseHooks"]` so the
hook signatures stay in lockstep with Better Auth's `Account` type
without importing `better-auth` directly (it's transitive via `void`).

### Removed unused `WRIGHTFUL_PUBLIC_URL` env var

The audit review flagged that `WRIGHTFUL_PUBLIC_URL` was declared in
`env.ts` but no longer read by any source code — the old `better-auth.ts`
used it as Better Auth's `baseURL`, but the new `auth.ts` relies on Void's
default request-origin inference. Removed the declaration. (User had
already dropped it from `env.ts` before this pass started.)

### Removed dead `src/lib/github-login.ts`

`captureGithubLogin` lives inline in `auth.ts` (uses dynamic imports so
`void prepare` can evaluate the file at config time). The standalone
`src/lib/github-login.ts` was a duplicate with no importers — deleted.

## What was left deferred

The audit-tightening worklog listed six OPTIMIZATION items. Re-evaluated
in this pass:

1. **`createInsertSchema` from `void/drizzle-zod`** — still rejected. Hand-written Zod schemas in `src/lib/schemas.ts` encode richer constraints (per-attempt min counts, status enums) than table-derived schemas can express.
2. **Drizzle `relations()`** — attempted, reverted. `relations` isn't re-exported from `void/db` or `void/schema-d1`, and `drizzle-orm` isn't a direct dependency (void bundles it). Adding it just for relational query helpers when existing explicit joins work is not worth the dep churn.
3. **`userGithubAccounts` → Better Auth `additionalFields`** — still deferred. Even pre-cutover the refactor touches 12 files (`auth.ts`, schema, invite-identity, authz, two settings pages, two invite routes); better as its own focused change.
4. **Explicit `trustedOrigins`** — skipped. Without `WRIGHTFUL_PUBLIC_URL` there's no env source for it, and Void's request-origin default is sufficient.
5. **`void env check --remote` in CI** — no CI configured yet; revisit when it exists.
6. **`inference.bindings.kv: false`** — purely documentary; we don't import `void/kv`.

## Verification

```bash
cd packages/dashboard-void
pnpm exec void prepare       # ✓ codegen ok (clean route paths now)
pnpm exec tsc --noEmit       # 0 errors
pnpm exec vp check           # 0 errors, 76 warnings (baseline unchanged)
```

The two latent bugs (slug/id schema mismatch + method-suffixed URLs) were
not exercised by previous worklog verifications because the seed/ingest
flows haven't been run end-to-end against dashboard-void yet — only
sign-in/sign-up via void-managed `/api/auth/*` had been exercised.
