# 2026-05-25 — Settings redesign (dashboard-void)

## What changed

Ported the Settings surface in `packages/dashboard-void` to match the
Wrightful design handoff (`screen-settings.jsx`). Two structural shifts:

- **Profile** went from a read-only `name · email` stub to a populated page
  with Identity (editable display name), Connected accounts (GitHub link/
  unlink), Password change, and Sign-out cards. Mutations run client-side
  against the Better Auth client (`auth` from `void/client`).
- **Team detail** split from one mega-page into three sub-pages:
  - `/settings/teams/[teamSlug]/general` — name + slug + Danger zone.
  - `/settings/teams/[teamSlug]/members` — member list + invite create/revoke.
  - `/settings/teams/[teamSlug]/projects` — project list with API-keys deep
    link + "New project" CTA.
  - `/settings/teams/[teamSlug]` now 302s to `…/general` as the default tab.

The sidebar (`SettingsNav` in `src/components/app-layout.tsx`) was rewritten
to mirror the prototype's grouped pattern: Account → {active team name} →
{active project name}. The active team is parsed from the path; the
team-switcher list is kept below the contextual groups so users can still
cross-navigate between teams.

The project API-keys page (`teams/[teamSlug]/p/[projectSlug]/keys`) was
restyled with the new primitives but the server contract (named actions,
flash-cookie one-time reveal) is unchanged.

## Details

| Area              | Change                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitives        | New `src/components/settings/settings-primitives.tsx` exporting `SettingsPage`, `SettingsHeader`, `SettingsCard`, `SettingsField`, `SettingsGroupGap`. Translated literal from `screen-settings.jsx` lines 19–50 using the existing Tailwind token mapping in `src/styles.css` (`bg-bg-1`, `border-line-1`, `text-fg-3`, `text-[length:var(--text-fs-*)]`).                                                             |
| Profile loader    | `pages/settings/profile.server.ts` now queries the void-managed `account` table (raw SQL — same pattern used elsewhere in `authz.ts`) to derive `hasPassword` and to detect the GitHub link. `userGithubAccounts` gives the `@login`. Renders the GitHub card only when `AUTH_GITHUB_CLIENT_ID`+`AUTH_GITHUB_CLIENT_SECRET` are configured. Renders the Password card only when the user signed up with email/password. |
| Profile mutations | `authClient.updateUser({ name })`, `authClient.unlinkAccount({ providerId })`, `authClient.changePassword({ currentPassword, newPassword })`, `authClient.signOut()`. Errors surface inline per-card.                                                                                                                                                                                                                   |
| Team General      | Actions `updateGeneral` + `deleteTeam` moved verbatim from the deleted `index.server.ts` actions block. On rename the redirect goes to `/general` instead of the bare team URL.                                                                                                                                                                                                                                         |
| Team Members      | Actions `createInvite` + `revokeInvite` moved verbatim, with flash-cookie path narrowed to `…/members` (was `…/`). Members list + pending-invite rows use the prototype's avatar + role-pill layout.                                                                                                                                                                                                                    |
| Team Projects     | New loader returns the project list; no actions (create-project flow is unchanged at `…/projects/new`).                                                                                                                                                                                                                                                                                                                 |
| Sidebar           | `SettingsNav` derives the active team from `pathname.match(/^\/settings\/teams\/([^/]+)(?:\/p\/([^/]+))?/)`. Team name pulled from `userTeams` (already in `shared`); when on a project sub-page, the project slug is used as the section label (no extra DB hit).                                                                                                                                                      |
| Keys page         | Pure visual port — `SettingsHeader` + back-link + identity card + keys card + Danger zone. Inline create-key form folded into the same card as the keys list (prototype shows them together).                                                                                                                                                                                                                           |

## Routes after

```
/settings/profile                                      Profile (4 cards)
/settings/teams/new                                    Create team   (unchanged)
/settings/teams/[teamSlug]                             302 → /general
/settings/teams/[teamSlug]/general                     Identity + Danger zone
/settings/teams/[teamSlug]/members                     Members + invites
/settings/teams/[teamSlug]/projects                    Project list
/settings/teams/[teamSlug]/projects/new                Create project (unchanged)
/settings/teams/[teamSlug]/p/[projectSlug]/keys        Project identity + API keys + Danger zone
```

## Files

| File                                                       | Change                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/components/settings/settings-primitives.tsx`          | created                                                                   |
| `pages/settings/profile.server.ts`                         | rewritten — adds `hasPassword`, `githubAccount`, `githubEnabled`          |
| `pages/settings/profile.tsx`                               | rewritten — 4 client-side cards                                           |
| `pages/settings/teams/[teamSlug]/general.server.ts`        | created — owns `updateGeneral`, `deleteTeam`                              |
| `pages/settings/teams/[teamSlug]/general.tsx`              | created                                                                   |
| `pages/settings/teams/[teamSlug]/members.server.ts`        | created — owns `createInvite`, `revokeInvite`                             |
| `pages/settings/teams/[teamSlug]/members.tsx`              | created                                                                   |
| `pages/settings/teams/[teamSlug]/projects.server.ts`       | created                                                                   |
| `pages/settings/teams/[teamSlug]/projects.tsx`             | created                                                                   |
| `pages/settings/teams/[teamSlug]/index.server.ts`          | rewritten — 302 → `./general`                                             |
| `pages/settings/teams/[teamSlug]/index.tsx`                | reduced to a no-op fallback                                               |
| `pages/settings/teams/[teamSlug]/p/[projectSlug]/keys.tsx` | restyled to use the new primitives; server contract unchanged             |
| `src/components/app-layout.tsx`                            | `SettingsNav` rewritten with grouped Account / {team} / {project} pattern |

## Notes for future work

- The prototype's "Default Playwright project" card and `Manage` row actions
  on members are out of scope — neither has schema backing today. Leave
  these for a follow-up that introduces the schema change.
- Member-role changes and member removal weren't part of this redesign —
  the UI lists members but doesn't yet edit them.
- Connect-GitHub flow uses the existing `/api/auth/sign-in/social?provider=github`
  endpoint; Better Auth handles the OAuth round-trip.

## Verification

- `pnpm exec vp lint packages/dashboard-void` → 69 warnings, 0 errors
  (warnings are all pre-existing `no-unsafe-type-assertion` flags).
- `pnpm exec tsgo --noEmit` (dashboard-void) → exit 0.
- `pnpm --filter @wrightful/dashboard-void test` → 91 passed.
- `vp check` reports formatting issues only in gitignored `.context/`
  scratch files; nothing in the worked-on tree.
- Manual e2e checks deferred to the user (per memory, never spawn `pnpm dev`).
