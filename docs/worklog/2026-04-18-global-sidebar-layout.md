# 2026-04-18 — Global sidebar layout via rwsdk `layout()`

## What changed

Introduced a global `AppLayout` component wired through rwsdk's `layout()` route helper so the sidebar shell is rendered once for every authenticated dashboard page instead of being bolted onto each page individually. `/login` and `/signup` sit outside the layout and remain full-screen.

Previously only `runs-list.tsx` and `run-detail.tsx` wrapped their content in `ProjectShell` — admin pages, picker pages, `test-detail`, and `test-history` rendered without a sidebar, which made navigation inconsistent. Each consuming page also re-fetched `getUserTeams` + `getTeamProjects` just to feed the sidebar.

## Details

| File                                                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/app/components/app-layout.tsx`    | **New.** Server component receiving `LayoutProps`. Reads `teamSlug` / `projectSlug` from `requestInfo.params` (both optional), fetches `teams` / `active team` / `projects` / `active project` conditionally via the existing `authz.ts` helpers, derives `activeNav` from the URL pathname, and renders the sidebar shell lifted from `project-shell.tsx`. Gracefully hides the project-nav section and project switcher on pages without an active team/project (picker pages, `/admin/teams`, etc.). |
| `packages/dashboard/src/worker.tsx`                       | Imported `layout` from `rwsdk/router` and `AppLayout`. Kept `/login` and `/signup` as top-level routes under `render(Document, …)`, wrapped everything else (team/project/admin routes) in `layout(AppLayout, [...])`.                                                                                                                                                                                                                                                                                  |
| `packages/dashboard/src/app/pages/runs-list.tsx`          | Removed `ProjectShell` wrapper and the `getUserTeams` / `getTeamProjects` calls that only existed to feed it.                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/dashboard/src/app/pages/run-detail.tsx`         | Same as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/dashboard/src/app/components/project-shell.tsx` | **Deleted** — no remaining consumers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Notes

- `AppLayout` uses the existing `authz.ts` helpers (`getUserTeams`, `resolveTeamBySlug`, `getTeamProjects`, `resolveProjectBySlugs`) rather than reinventing membership-scoped queries. Each helper already verifies membership, so the sidebar cannot render team/project data the user isn't entitled to see.
- `activeNav` is derived from the URL (`/tests/` → `tests`, otherwise `runs`) instead of being passed per-page — pages no longer need to declare their active nav item.
- The three pre-existing `no-unsafe-type-assertion` warnings in `active-project.ts` and `route-params.ts` stem from the loose typing of `requestInfo.params`; the layout follows the same pattern.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 55/55 pass (vitest).
- `pnpm lint` — 0 errors, 3 warnings (all pre-existing `requestInfo.params` assertion pattern).
- Manual dev-server walkthrough pending.

## Follow-up: admin pages consolidated into sidebar + settings

With the team/project switchers in the global sidebar, the `/admin/teams` list page became redundant. Removed it; the switchers now cover team discovery and selection.

`/admin/t/:teamSlug` was reshaped into a **Settings** page with a tabbed shell. The first tab, "Team", shows team info (name, slug), members, and the project list (with per-project API-keys link and "Create project" action). Additional tabs (billing, integrations, etc.) can be added later without touching the routing.

Sidebar Settings link now points at `/admin/t/:teamSlug` and shows whenever a team is active (previously it only rendered with an active project and pointed at that project's API-keys page). API keys remain reachable via the Projects list in team settings.

Additional changes:

| File                                                     | Change                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/dashboard/src/app/pages/admin/teams.tsx`       | **Deleted.**                                                                     |
| `packages/dashboard/src/worker.tsx`                      | Dropped `AdminTeamsPage` import + `/admin/teams` route.                          |
| `packages/dashboard/src/app/pages/admin/team-detail.tsx` | Rebuilt as tabbed settings page using the existing `Tabs` UI primitive.          |
| `packages/dashboard/src/app/pages/team-picker.tsx`       | Removed "Manage teams" link.                                                     |
| `packages/dashboard/src/app/pages/admin/team-new.tsx`    | Back-link now points at `/` (team picker) instead of the deleted `/admin/teams`. |
| `packages/dashboard/src/app/components/app-layout.tsx`   | Settings link shows with any active team and targets `/admin/t/:teamSlug`.       |

## Follow-up: Linear-style `/settings` area with dual-content sidebar

Replaced `/admin/*` entirely with a Linear-inspired `/settings` surface. Key decisions:

- **Settings is user-scoped, not team-scoped.** Users see their list of teams from inside settings (`/settings/teams`) and drill into each one. No team slug in the settings URL prefix, leaving room for future user-level sections (Profile, Notifications, Billing).
- **Single `AppLayout` branches sidebar contents by pathname.** `pathname.startsWith("/settings")` flips the sidebar to settings mode without remounting the `<nav>` element. This keeps the DOM stable between app and settings so we can wire a cross-fade/slide animation later (à la Vercel/Linear) without restructuring the layout.

**URL scheme:**

| Path                                            | Purpose                      |
| ----------------------------------------------- | ---------------------------- |
| `/settings`                                     | 302 → `/settings/teams`      |
| `/settings/profile`                             | Placeholder                  |
| `/settings/teams`                               | Team list + "Create team"    |
| `/settings/teams/new`                           | Create team form             |
| `/settings/teams/:teamSlug`                     | Team detail — info + members |
| `/settings/teams/:teamSlug/projects`            | Projects + "Create project"  |
| `/settings/teams/:teamSlug/projects/new`        | Create project form          |
| `/settings/teams/:teamSlug/p/:projectSlug/keys` | API keys                     |

Within team-scoped settings pages, a small `TeamSettingsSubnav` (new) renders a horizontal link strip (Team / Projects) so the layout stays oblivious to team params.

**Settings sidebar contents:**

- `< Back to app` → `/`
- _Account_ — Profile
- _Workspaces_ — Teams

**Additional changes:**

| File                                                             | Change                                                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/app/components/app-layout.tsx`           | Split into `AppSidebarContents` + `SettingsSidebarContents` within the same file; outer `<nav>` and `<main>` shell stays stable. Fetches app-mode data only when `mode === "app"`. |
| `packages/dashboard/src/app/components/team-settings-subnav.tsx` | **New.** Horizontal link strip for Team / Projects tabs inside team-scoped settings pages.                                                                                         |
| `packages/dashboard/src/app/pages/admin/*`                       | **Deleted (directory).**                                                                                                                                                           |
| `packages/dashboard/src/app/pages/settings/profile.tsx`          | **New** placeholder.                                                                                                                                                               |
| `packages/dashboard/src/app/pages/settings/teams.tsx`            | **New** team list + Create team action.                                                                                                                                            |
| `packages/dashboard/src/app/pages/settings/team-new.tsx`         | Moved from `admin/team-new.tsx`; redirect URLs updated to `/settings/teams/...`.                                                                                                   |
| `packages/dashboard/src/app/pages/settings/team-detail.tsx`      | Slimmed from `admin/team-detail.tsx` — info + members only; embeds `TeamSettingsSubnav`.                                                                                           |
| `packages/dashboard/src/app/pages/settings/projects.tsx`         | **New** — projects list + per-row "API keys" + create action; embeds `TeamSettingsSubnav`.                                                                                         |
| `packages/dashboard/src/app/pages/settings/project-new.tsx`      | Moved from `admin/project-new.tsx`; redirect URLs updated.                                                                                                                         |
| `packages/dashboard/src/app/pages/settings/project-keys.tsx`     | Moved from `admin/project-keys.tsx`; redirect + cookie path updated.                                                                                                               |
| `packages/dashboard/src/worker.tsx`                              | Registered `/settings/*` routes; added `settingsRootRedirect` handler for `/settings` → `/settings/teams`. Dropped all admin imports/routes.                                       |
| `packages/dashboard/src/app/components/project-switcher.tsx`     | "Create project" link → `/settings/teams/:teamSlug/projects/new`.                                                                                                                  |
| `packages/dashboard/src/app/components/team-switcher.tsx`        | "Create team" link → `/settings/teams/new`.                                                                                                                                        |
| `packages/dashboard/src/app/pages/project-picker.tsx`            | Updated project/team-settings links.                                                                                                                                               |
| `packages/dashboard/src/app/pages/team-picker.tsx`               | Create-team link → `/settings/teams/new`.                                                                                                                                          |

**Verification:**

- `pnpm --filter @wrightful/dashboard typecheck` — clean. `linkFor<App>()` type-checks every `link("/settings/...")` call against the registered routes.
- `pnpm --filter @wrightful/dashboard test` — 55/55 pass.
- `pnpm lint` — 0 errors, 3 warnings (pre-existing `requestInfo.params` assertion pattern).
- Dev-server smoke test with `curl`:
  - `GET /settings` → 302 `/settings/teams` ✓
  - `GET /settings/teams` (unauth) → 302 `/login?next=%2Fsettings%2Fteams` ✓
  - `GET /login` → 200 ✓
  - `GET /t/demo` (unauth) → 302 `/login?next=%2Ft%2Fdemo` ✓
- Authenticated manual walkthrough still pending.

## Follow-up: persist last-visited team + project

Users now keep their last-visited team + project across sessions and devices. Visiting `/` (after login, after "Back to app", or directly) drops the user straight into the team + project they last chose via a combobox — no re-picking required.

**Storage — new `user_state` table** (one row per user):

| Column            | Type                   | Notes                                 |
| ----------------- | ---------------------- | ------------------------------------- |
| `user_id`         | text PK                | FK → `user.id` ON DELETE CASCADE      |
| `last_team_id`    | text nullable          | FK → `teams.id` ON DELETE SET NULL    |
| `last_project_id` | text nullable          | FK → `projects.id` ON DELETE SET NULL |
| `updated_at`      | integer (timestamp_ms) | Updated on every UPSERT               |

IDs (not slugs) — safe across any future rename; FKs with SET NULL mean stale pointers silently fall back to defaults instead of 500ing.

**Migration:** squashed per project convention — deleted `0000_odd_gamma_corps.sql` + `0001_whole_madame_web.sql` (and their snapshots), reset `_journal.json`, regenerated a single `0000_milky_malice.sql` covering the full schema. Local D1 wiped and re-migrated (37 commands applied).

**Capturing explicit switches only** — no per-page-view writes. The team + project comboboxes (`team-switcher.tsx`, `project-switcher.tsx`) fire a `fetch(..., { keepalive: true })` before `navigate()`:

- `POST /api/user/last-team` `{ teamSlug }` — upserts `last_team_id`.
- `POST /api/user/last-project` `{ teamSlug, projectSlug }` — upserts both.

`keepalive: true` ensures the write survives `navigate()` unloading the page. Responses are 204 on success, 400 on invalid body, 404 when the user has no membership. Handlers use Zod for body validation (matching the ingest API pattern).

**Redirect on `/`** — `TeamPickerPage` now calls `resolveDefaultLanding(userId)`:

1. Stored `(lastTeamId, lastProjectId)` if the user still has membership.
2. Else stored `lastTeamId` + first project in that team.
3. Else the user's first team (by id order) + its first project.
4. Else null → "no teams yet" empty state.

This covers login (Better Auth `callbackURL` defaults to `/`), "Back to app" from the settings sidebar, and direct `/` visits. `/t/:teamSlug` still shows the project picker — the redirect is `/`-only.

**Additional changes:**

| File                                                         | Change                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/db/schema.ts`                        | Added `userState` table with FK cascades.                                                                                                                                         |
| `packages/dashboard/drizzle/*`                               | Squashed to single `0000_milky_malice.sql`.                                                                                                                                       |
| `packages/dashboard/src/lib/user-state.ts`                   | **New.** `resolveDefaultLanding`, `setLastTeam`, `setLastProject`.                                                                                                                |
| `packages/dashboard/src/routes/api/user-state.ts`            | **New.** Zod-validated POST handlers for the two endpoints.                                                                                                                       |
| `packages/dashboard/src/worker.tsx`                          | Wired `POST /api/user/last-team` + `POST /api/user/last-project` as session-gated (loadSession + requireUser) top-level routes, ahead of the bearer `/api` prefix.                |
| `packages/dashboard/src/app/components/team-switcher.tsx`    | `onValueChange` now fires the fire-and-forget POST before navigate.                                                                                                               |
| `packages/dashboard/src/app/components/project-switcher.tsx` | Same.                                                                                                                                                                             |
| `packages/dashboard/src/app/pages/team-picker.tsx`           | Calls `resolveDefaultLanding`, 302s on a hit. Multi-team list UI removed — team choice happens via the sidebar switcher. "No teams yet" empty state remains as the sole fallback. |

**Verification:**

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 55/55 pass.
- `pnpm lint` — 0 errors, 3 warnings (pre-existing `requestInfo.params` assertion pattern).
- `curl` smoke test:
  - `POST /api/user/last-team` (unauth) → 302 to `/login` (from `requireUser`) ✓
  - `GET /` (unauth) → 302 to `/login?next=%2F` ✓
  - `GET /settings` (unauth) → 302 to `/settings/teams` ✓
- Authenticated walkthrough (login → landing spot, switcher → POST, log out / log in → same landing) still needs a human pass.
