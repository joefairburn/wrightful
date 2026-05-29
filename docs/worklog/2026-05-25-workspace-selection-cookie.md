# 2026-05-25 — Workspace selection moved to a cookie, sidebar unified across modes

## What changed

The workspace switcher used to disappear on `/settings/*` routes because its
data (`shared.activeTeam` / `shared.activeProject`) was URL-derived and the
settings paths set those to `null`. A small "Back to app" link sat at the top
of the settings sidebar in its place. The two layouts felt out of sync.

Two coupled changes:

1. **Selection now lives in a `wf_workspace` cookie**, not in the
   `userState` DB table. Middleware reads the cookie, lets the URL override
   when present, and rewrites the cookie when the URL pins a new
   team/project. Nothing on the hot path hits the DB for selection.
2. **The sidebar is now structurally identical in both modes** — workspace
   switcher always at the top (when a workspace is selected), and a single
   utility link at the bottom (Settings in app mode, "Back to app" in
   settings mode).

`shared` was renamed `activeTeam → selectedTeam` and `activeProject →
selectedProject` to distinguish from the URL-bound `c.var.activeProject`
(the branded `AuthorizedProjectId`, still used for loader authorization —
unchanged).

## Cookie format

| Attribute | Value                                                          |
| --------- | -------------------------------------------------------------- |
| Name      | `wf_workspace`                                                 |
| Value     | `${teamSlug}:${projectSlug}` (or `${teamSlug}:` if no project) |
| Path      | `/`                                                            |
| Max-Age   | 1 year                                                         |
| HttpOnly  | yes                                                            |
| SameSite  | Lax                                                            |
| Secure    | yes when request is HTTPS                                      |

Slugs are validated against `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` on read.
Membership is filtered server-side through `resolveTenantBundleForUser`, so a
forged or stale cookie can only resolve to nulls — never to a workspace the
user isn't already in. No auth bypass surface.

## Resolution flow per request

```
if /api/* or unauthenticated → stub bundle (no cookie read/write)
else:
  (urlTeam?, urlProject?) ← TENANT_PATH_RE
  (cookieTeam?, cookieProject?) ← parse wf_workspace
  effectiveTeam = urlTeam ?? cookieTeam
  effectiveProject = urlProject
    ?? (cookieTeam === effectiveTeam ? cookieProject : null)
  bundle = resolveTenantBundleForUser(userId, effectiveTeam, effectiveProject)
  shared = { selectedTeam, selectedProject, teamProjects, userTeams }
  if URL pinned a team:
    c.var.activeProject = bundle.activeProject  (URL-bound, auth-checked)
    if URL resolved to null   → clear cookie if set
    elif desired ≠ current    → set cookie to resolved slugs
```

## Files

| File                                                              | Change                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workspace-cookie.ts`                                     | New: `readWorkspaceCookie` / `setWorkspaceCookie` / `clearWorkspaceCookie` helpers.                                                                                                                                   |
| `middleware/01.context.ts`                                        | Cookie-backed resolution; `SharedBundle` renamed; `backToAppHref` dropped (computed in sidebar).                                                                                                                      |
| `src/components/app-layout.tsx`                                   | Refactored into `SidebarTop` / `SidebarMiddle` (app + settings variants) / `SidebarBottom`. Switcher at top of both modes; "Back to app" moved to bottom in settings mode.                                            |
| `src/components/workspace-switcher.tsx`                           | Props renamed `activeTeam`/`activeProject` → `selectedTeam`/`selectedProject`. Dropped the explicit `POST /api/user/last-team` and `/api/user/last-project` calls — middleware writes the cookie on the next request. |
| `pages/index.server.ts`                                           | Default landing now reads `c.var.shared.selectedTeam/Project` (already resolved by middleware) instead of calling a `resolveDefaultLanding` helper.                                                                   |
| `pages/settings/teams/[teamSlug]/p/[projectSlug]/keys.server.ts`  | Dropped `userState` cleanup from project-delete batch.                                                                                                                                                                |
| `pages/settings/teams/[teamSlug]/general.server.ts`               | Dropped `userState` cleanup from team-delete batch.                                                                                                                                                                   |
| `routes/api/user/last-team.ts`, `routes/api/user/last-project.ts` | Deleted (no callers).                                                                                                                                                                                                 |
| `src/lib/user-state.ts`                                           | Deleted.                                                                                                                                                                                                              |

## Code that survived intentionally

- The `userState` table itself stays in `db/schema.ts` and the existing
  migration. Per the project's "stack migrations are frozen" rule, we don't
  edit applied migrations. The table will be dropped in a future migration
  once a deployment window confirms nothing writes to it.
- `c.var.activeProject` (the URL-bound, branded auth channel) is unchanged.
  Loaders calling `getActiveProject(c)` continue to work exactly as before;
  authorization is _not_ driven by the cookie.

## Verification

- `pnpm --filter @wrightful/dashboard-void exec vp check` — 0 errors,
  70 warnings (all pre-existing in unrelated files).
- `pnpm --filter @wrightful/dashboard-void test` — 91/91 tests passing.
- Manual verification (handed off to user; not run by the agent):
  - `/t/:team/p/:project` → switcher at top, Settings at bottom. Response
    has `Set-Cookie: wf_workspace=team:project`.
  - Click Settings → `/settings/profile`: switcher still shows the same
    workspace at top (read from cookie), "Back to app" at bottom.
  - Switch via the popover from settings → URL changes, cookie rewritten.
    No `POST /api/user/last-team` in network tab.
  - Delete the cookie manually → next non-tenant page shows the "Wrightful"
    placeholder; "Back to app" → `/`.

## Follow-ups

- Drop the `userState` table in a future migration.
- The `wf_workspace` cookie is per-device by design — different machines can
  remember different defaults. If we ever want cross-device sync, restore a
  DB-backed lookup as a _read-only_ fallback under the cookie (write the
  cookie from the DB on first session bootstrap).
