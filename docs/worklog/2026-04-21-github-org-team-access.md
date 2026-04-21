# 2026-04-21 — GitHub org → auto-access teams

## What changed

Before: joining a team required an owner to generate a tokenised invite link
and share it out-of-band. After: a team owner can link their team to a GitHub
organisation slug, and any dashboard user who is a member of that GitHub org
will see the team appear in their sidebar's team dropdown with a **Join**
button (one click, direct membership) and an **X** to dismiss. The same list
also surfaces on `/settings/profile` — including dismissed entries, with an
Un-dismiss action — so the sidebar dismiss is not final.

The invite flow is unchanged; this is purely additive.

## Details

### Schema

Single migration (`0000_init.sql` — pre-launch squash policy).

| Table                        | Change                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `teams`                      | `github_org_slug TEXT NULL` + non-unique index                                  |
| `team_suggestion_dismissals` | new: `(user_id, team_id, dismissed_at)`, PK `(user,team)`                       |
| `user_github_orgs`           | new: cache keyed by `user_id` with `org_slugs_json`, `refreshed_at`, `scope_ok` |

Kysely types updated in `packages/dashboard/src/db/schema.ts`. Two teams may
claim the same org (valid for a split between a personal and production team).

### GitHub OAuth scope

`packages/dashboard/src/lib/better-auth.ts` now requests
`scope: ["read:org", "user:email"]` on the GitHub social provider. Existing
users who signed in before this change keep their narrower token; the profile
page shows a "Reconnect GitHub" banner so they can opt in.

### GitHub API integration

New: `packages/dashboard/src/lib/github-orgs.ts`

- `fetchUserOrgsFromGithub(token)` — calls `GET /user/orgs` and distinguishes
  three failure modes we care about: `no_token`, `scope_missing` (403 with
  `read:org` in `x-accepted-oauth-scopes` but not in `x-oauth-scopes`), and
  generic `error`.
- `getCachedUserOrgs(userId)` — reads `user_github_orgs`; considers a cache
  stale after 30 minutes.
- `refreshUserOrgs(userId)` — loads the access token from Better Auth's
  `account` row, hits GitHub, upserts the cache. Falls back to the existing
  cache on transient errors so we don't overwrite good data with an empty
  list.

Refresh triggers:

| Caller                                                 | Behaviour                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Better Auth `databaseHooks.account.create` / `.update` | Awaited, best-effort (try/catch). Populates cache on first GitHub sign-in and re-auth |
| Team picker (`/`) when cache is missing                | Awaited fallback — keeps first-run landing correct if the hook misfired               |
| `/settings/profile` load                               | Awaits a fresh refresh                                                                |
| `POST /t/:teamSlug/join`                               | Awaits a fresh refresh (authoritative check)                                          |
| `POST /t/:teamSlug/settings/github-org`                | Awaits a fresh refresh (org-claim verification)                                       |
| Sidebar render (`app-layout.tsx`)                      | Reads cache only; never refreshes                                                     |

The sidebar intentionally never refreshes — sign-in hook + first-run landing
are the two places that populate the cache; the sidebar rides it after
that. This keeps every subsequent page render off GitHub's API.

### Authz

New `getSuggestedTeamsForUser(userId)` in
`packages/dashboard/src/lib/authz.ts` — LEFT-joins `teams` against cached
orgs, filters out teams the user is already in, and tags dismissed rows. The
sidebar filters dismissed; the profile page shows everything.

`resolveTeamBySlug` now also returns `githubOrgSlug` (additive). New
`requireTeamOwner` helper exists but isn't used in this change (the
`teamDetailHandler` already checks `role === "owner"`).

### API surface

| Route                                                  | Method | Handler                      |
| ------------------------------------------------------ | ------ | ---------------------------- |
| `/t/:teamSlug/join`                                    | POST   | `joinTeamHandler`            |
| `/api/user/team-suggestions/:teamId/dismiss`           | POST   | `dismissSuggestionHandler`   |
| `/api/user/team-suggestions/:teamId/undismiss`         | POST   | `undismissSuggestionHandler` |
| `/settings/teams/:teamSlug` `action=update-github-org` | POST   | extended `teamDetailHandler` |

All three live in `packages/dashboard/src/routes/api/team-suggestions.ts`
(except the settings update, which is a new action branch in
`team-detail.tsx`'s existing handler).

- **Join**: looks up the team by slug, bails if not a member and the team has
  no `githubOrgSlug`, then _awaits_ `refreshUserOrgs` to verify org
  membership at action time (the 30-minute cache is not trusted here). On
  success, inserts the membership row (`ON CONFLICT DO NOTHING`) and clears
  any existing dismissal.
- **Dismiss / undismiss**: upserts / deletes the dismissal row. Returns 303
  to `Referer` when present (browser form POSTs) or 204 otherwise (fetch
  callers from the sidebar).
- **Set GitHub org**: validates against a GitHub login regex, requires the
  acting owner to be a member of the claimed org (so you can't claim orgs
  you don't belong to), then persists.

### UI

- `packages/dashboard/src/app/components/team-switcher.tsx` — now a
  discriminated-union of `joined` / `suggested` items in the same combobox
  list (so search still finds them). Suggested rows carry a "Join" chip plus
  a `<form>` POST (Join, opens the team) and a client-side Dismiss button
  (optimistic hide + background POST).
- `packages/dashboard/src/app/components/app-layout.tsx` — `fetchAppSidebarData`
  now also calls `getSuggestedTeamsForUser` in parallel, filters out dismissed
  entries, and passes the rest to `TeamSwitcher`.
- `packages/dashboard/src/app/pages/settings/profile.tsx` — replaces the
  "Coming soon" placeholder. RSC list of all suggestions (including
  dismissed, with Un-dismiss), a Reconnect-GitHub banner for scope-missing
  users, an empty state for email/password users.
- `packages/dashboard/src/app/pages/settings/team-detail.tsx` — new
  "GitHub organisation" card in the owner-settings column with a single
  slug input + save button.
- `packages/dashboard/src/app/pages/team-picker.tsx` — when a user has no
  teams, the landing shows the suggestion list as a first-run prompt
  ("Get started — join one of your GitHub org's teams, or create your own")
  instead of the old "Create a team" empty state. Falls back to the empty
  state when there are no suggestions.

### Routes registered

`src/worker.tsx` gains three new routes (join, dismiss, undismiss) and the
existing team-settings POST now handles the `update-github-org` action.

## Verification

- `pnpm --filter @wrightful/dashboard test` — 14 test files, 151 tests (12 new).
  - `github-orgs.test.ts` covers: `hasReadOrgScope` scope-string parsing
    (space + comma forms, null/empty); `fetchUserOrgsFromGithub` happy path
    - lowercase normalisation + 403-scope-missing + 403-granted + 401;
      `joinTeamHandler` 404 / already-member short-circuit / scope-mismatch
      403 / successful insert + dismissal clear / case-insensitive org match /
      unauthenticated 401.
- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm lint` — 0 errors, 19 warnings (all pre-existing in `@wrightful/reporter`).
- `pnpm format` — clean.
- Manual QA is required (user runs `pnpm dev` themselves):
  1. Sign in with GitHub — consent screen now asks for `read:org`.
  2. As team owner, set a GitHub org slug on a team; try one you're _not_ in
     → should reject with "You must be a member of that GitHub org to link it."
  3. As a second user in the same org: team appears in sidebar dropdown with
     a Join chip → click Join → membership created → land on the team page.
  4. Dismiss a different suggestion from the sidebar → it disappears; visit
     `/settings/profile` → the dismissed row still appears with Un-dismiss.
  5. Email/password-only user → sidebar/profile show no suggestions, no
     banner.

## Open questions carried forward

- SAML-gated enterprise orgs: `GET /user/orgs` silently omits orgs the OAuth
  token hasn't been SSO-authorised for. We don't surface a hint in v1.
- Cache TTL: 30 minutes with no sidebar-render refresh. If users report stale
  suggestions, the next step is `ctx.waitUntil`-based stale-while-revalidate
  in `fetchAppSidebarData`.
