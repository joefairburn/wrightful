# 2026-04-20 — GitHub org / email domain whitelist for signup + team invites

## What changed

Two new gates on who can land inside Wrightful:

1. **Instance-level whitelist** (self-hosters). Two new env vars —
   `SIGNUP_GITHUB_ORGS` and `SIGNUP_EMAIL_DOMAINS`, both comma-separated. When
   either is set, email/password signup is rejected at `/api/auth/sign-up/email`
   and every new GitHub user is validated on first dashboard request: their
   GitHub `/user/orgs` membership and verified primary email domain are
   checked against the allow-lists. A failing user's `user` row is deleted
   (FK cascade cleans up `session`/`account`/`user_state`/`memberships`), the
   `better-auth.session_token` cookie is cleared, and they're redirected to
   `/signup?error=not_allowed`. Users who already belong to any team are
   grandfathered (we skip the check once `memberships` is non-empty).

2. **Per-team invite link** (team owners). Two new columns on `teams` —
   `github_org_whitelist` and `email_domain_whitelist`. Team owners set either
   (or both) from `/settings/teams/:slug`, which activates the shareable
   `/invite/:teamSlug` link. Visitors without a session see a "Continue with
   GitHub" CTA that round-trips back to the invite page. Authenticated GitHub
   users whose verified email domain or org membership matches the team's
   whitelist get an "Accept invite" button; the POST handler re-runs the
   check server-side and inserts a member-role `memberships` row (idempotent
   via `ON CONFLICT DO NOTHING` on the existing `memberships_user_team_idx`
   unique index) before redirecting into the team.

Whitelist checks are GitHub-only by design: GitHub's OAuth returns a verified
primary email and membership listing, which is the only trustworthy identity
signal we have without a mailer. Email/password users cannot satisfy either
list, so they're refused at the signup edge whenever a whitelist is active.

## Details

### New env vars

| Var                    | Type            | Purpose                                                                                 |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `SIGNUP_GITHUB_ORGS`   | comma-separated | Instance allow-list of GitHub org logins. Case-insensitive.                             |
| `SIGNUP_EMAIL_DOMAINS` | comma-separated | Instance allow-list of email domains (matched against GitHub's verified primary email). |

Both are documented in `wrangler.jsonc`, `types/env.d.ts`, and the
`Required env vars` section of `CLAUDE.md`.

### Schema

Added two nullable `TEXT` columns to `teams`:

- `github_org_whitelist`
- `email_domain_whitelist`

Both store the raw comma-separated string entered by the owner; parsing is
done on read via `parseList` in `src/lib/whitelist.ts`.

Per the pre-launch rule about not stacking migrations, the columns were
folded into `drizzle/0000_misty_miss_america.sql` and the `0000` snapshot in
`drizzle/meta/` was re-issued. `pnpm db:generate` reports "no schema
changes" afterwards.

### Files touched

- **Schema + migration**
  - `packages/dashboard/src/db/schema.ts` — two new nullable columns on
    `teams`.
  - `packages/dashboard/drizzle/0000_misty_miss_america.sql` — CREATE TABLE
    extended.
  - `packages/dashboard/drizzle/meta/0000_snapshot.json` — regenerated to
    match the new schema (0001 stack removed).
  - `packages/dashboard/drizzle/meta/_journal.json` — single entry.

- **New helpers**
  - `packages/dashboard/src/lib/whitelist.ts` — `parseList` and
    `matchesWhitelist` pure helpers (covered by
    `src/__tests__/whitelist.test.ts`, 11 tests).
  - `packages/dashboard/src/lib/github-api.ts` — `fetchUserOrgLogins` wrapping
    `GET https://api.github.com/user/orgs`.
  - `packages/dashboard/src/lib/instance-whitelist.ts` — reads
    `SIGNUP_GITHUB_ORGS` / `SIGNUP_EMAIL_DOMAINS` into a `WhitelistConfig`.

- **Auth**
  - `packages/dashboard/src/lib/better-auth.ts` — GitHub OAuth now requests
    `read:user user:email read:org` so the stored access token can hit
    `/user/orgs`.
  - `packages/dashboard/src/routes/auth.ts` — email/password signup is now
    blocked when the instance whitelist is set (on top of the existing
    `ALLOW_OPEN_SIGNUP` gate).
  - `packages/dashboard/src/routes/middleware.ts` — new
    `enforceInstanceWhitelist` middleware runs after `loadSession` for every
    `render(Document, …)` request. Skips users who already have any
    membership; otherwise loads the GitHub access token, hits
    `/user/orgs`, and runs `matchesWhitelist`. Failures delete the user and
    redirect to `/signup?error=not_allowed`.
  - `packages/dashboard/src/app/pages/login.tsx` — surfaces a destructive
    alert for the `?error=not_allowed` query param.

- **Team invite flow**
  - `packages/dashboard/src/app/pages/invite.tsx` — `/invite/:teamSlug` page
    - `POST` accept handler. Rejects unknown teams, teams with no whitelist
      configured, non-GitHub users, and users that fail the check — all with a
      neutral copy that doesn't leak team existence.
  - `packages/dashboard/src/worker.tsx` — registered `/invite/:teamSlug`
    outside `AppLayout` (visitors aren't members yet) but inside the
    `render(Document, …)` chain so `loadSession` and
    `enforceInstanceWhitelist` still run.

- **Team settings UI**
  - `packages/dashboard/src/app/pages/settings/team-detail.tsx` — owner-only
    "Access control" section with two comma-separated inputs, a Save button,
    and a copyable invite URL block. POST handler
    (`teamAccessControlHandler`) validates each entry with conservative
    regexes for GitHub org logins (`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`)
    and email domains, stores the lowercased list verbatim, and redirects
    back with `?access_saved=1` or `?access_error=…`.
  - `packages/dashboard/src/worker.tsx` — registered
    `POST /settings/teams/:teamSlug/access-control`.

### Reused utilities

- `parseBooleanEnv` (`src/lib/env-parse.ts`), `readField` (`src/lib/form.ts`),
  `resolveTeamBySlug` (`src/lib/authz.ts`), existing `ui/` components
  (`Button`, `Input`, `Field`, `Alert`, `Card`).

## Verification

- `pnpm typecheck` — clean.
- `pnpm lint` — 10 pre-existing warnings, 0 errors.
- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/whitelist.test.ts` —
  11 passing.
- `pnpm --filter @wrightful/dashboard test` — 101 passing, 1 pre-existing
  failure in `run-detail-scoping.test.ts` (`drizzle` alias proxy
  stack-overflow reproducible on main before this branch).
- `pnpm --filter @wrightful/dashboard db:generate` — "No schema changes,
  nothing to migrate" after the `0000` squash.

Manual verification (run by the maintainer with `pnpm dev`) should cover:

1. **No whitelist set** — email/password and GitHub signup both succeed; no
   regressions vs. today.
2. **Instance whitelist on** (`SIGNUP_GITHUB_ORGS=wrightful-test`) — POST
   `/api/auth/sign-up/email` returns 403; a GitHub user in `wrightful-test`
   lands on `/`; a GitHub user not in the org is bounced to
   `/signup?error=not_allowed` and the `user` row is gone
   (`wrangler d1 execute wrightful --local --command "select count(*) from user"`).
3. **Team invite on** — an owner sets `example.com` on their team; a second
   GitHub user with an `@example.com` primary email hits
   `/invite/<team-slug>` and is added as `member`; a third user with
   `@other.com` sees the neutral "not on allow-list" screen and the
   `memberships` table shows no new row for them.

## Non-goals

- No mailer — domain gating relies on GitHub's verified primary email and
  doesn't attempt SMTP or magic links. Revisit when email is wired.
- No per-user invite tokens — the `/invite/:teamSlug` link is shareable and
  rate-limited by the whitelist itself.
- Existing members whose GitHub org membership lapses later keep their
  access (sticky membership); a sweep task is a follow-up.

## Known limitations

- **Fail-closed deletes are aggressive.** `enforceInstanceWhitelist` treats
  any non-2xx from `GET /user/orgs` the same as a failed match — the user
  row is deleted. GitHub outages, transient 5xx responses, revoked tokens,
  and SAML-SSO-enforced orgs that the token isn't SSO-authorized for will
  all nuke legitimate non-grandfathered users. Acceptable today because the
  self-hoster population is small; if this starts producing support
  tickets, split transient failures (retry / show error) from auth
  failures (delete).
- **Scope widening doesn't re-prompt existing users.** GitHub access tokens
  issued before this change don't carry `read:org`, so a grandfathered user
  who later loses all memberships could fail the instance-whitelist check
  even though they're on the allow-list. Forcing a re-auth on next sign-in
  would fix this if it ever matters.
