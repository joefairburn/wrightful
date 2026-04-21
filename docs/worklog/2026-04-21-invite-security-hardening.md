# 2026-04-21 — Invite security hardening

## What changed

Security review of the team-invite flow surfaced three fixable issues before
launch; this change addresses them. Invite tokens are now hashed at rest, the
plaintext no longer appears in URLs, and an expired-invite POST shows an
explicit error instead of silently bouncing.

The review document (`.context/plans/security-review-team-invite-system.md`)
is the full audit. This worklog covers Tier 1 + L1 only. Rate-limiting and
other lower-priority items were intentionally deferred.

## Details

### Token handling

- New: `packages/dashboard/src/lib/invite-tokens.ts`
  - `generateInviteToken()` — 24 random bytes (192 bits) from
    `crypto.getRandomValues()`, base64url-encoded. Same entropy as the previous
    inline helper; lifted to a lib so creation and acceptance share it.
  - `hashInviteToken(token)` — SHA-256 → 64-char hex. Mirrors the `hashKey`
    pattern in `packages/dashboard/src/lib/auth.ts`. No slow KDF needed since
    the input is already 192-bit random.

- Schema: `packages/dashboard/src/db/schema.ts` and
  `packages/dashboard/migrations/0000_init.sql`
  - `team_invites.token` renamed to `team_invites.token_hash`, index renamed
    to `team_invites_token_hash_idx`. Edited migration 0000 in place per the
    pre-launch squash policy — no new numbered migration.

### One-shot reveal via flash cookie

- Modified: `packages/dashboard/src/app/pages/settings/team-detail.tsx`
  - `create-invite` handler now hashes the token before insert and stashes
    the plaintext URL in an HttpOnly, `SameSite=Strict`, path-scoped flash
    cookie (`wrightful_invite_flash`, `Max-Age=60`, `Secure` on HTTPS). The
    redirect URL carries only the invite `id` (`?newInvite=${inviteId}`) —
    the plaintext token never appears in the URL, browser history, access
    logs, or Referer.
  - `SettingsTeamDetailPage` reads the flash cookie on render, shows the
    modal once, then clears the cookie via
    `requestInfo.response.headers.append("Set-Cookie", …)`. Max-Age bounds
    the leak even if the follow-up render never happens.
  - Removed the "Show invite link" icon button on pending invites. With
    hashing in place there is no longer a plaintext to reveal — the URL is
    visible exactly once, at creation. Revocation still works; owners who
    lose the link revoke and re-create. Matches how API keys already behave.
  - Dropped `token`/`token_hash` from the invite list `SELECT`. The list UI
    doesn't need it.

### Acceptance path

- Modified: `packages/dashboard/src/app/pages/invite.tsx`
  - Both GET preview and POST accept now hash `params.token` and look up by
    `token_hash`. Plaintext token never reaches the DB.
  - POST to an expired / unknown / revoked invite now redirects with
    `?error=This invite is no longer valid. Ask the team owner for a fresh
link.` so the `<Alert>` surfaces on the GET. Previously it silently
    redirected with no context.

### Tests

- New: `packages/dashboard/src/__tests__/invites.test.ts` (7 tests)
  - `acceptInviteHandler` looks up by `token_hash`, never by plaintext
    (asserts on compiled SQL + parameters).
  - Valid accept emits a batch of `INSERT memberships` + `DELETE team_invites`
    via `batchD1`, and redirects to `/t/:slug`.
  - Expired/unknown invite → `?error=` redirect, no batch.
  - Already-member accept → redirects without burning the invite.
  - No authenticated user → 401, no DB access.
  - Helper invariants for `generateInviteToken` (URL-safe, ≥32 chars) and
    `hashInviteToken` (64 hex, deterministic).

## Verification

- `pnpm --filter @wrightful/dashboard test` — 139/139 pass (13 files,
  including the new 7-case `invites.test.ts`).
- `pnpm typecheck` — clean.
- `pnpm lint` — no new warnings introduced (18 pre-existing warnings in
  `packages/reporter/src/client.ts` unchanged).
- `pnpm format` — clean.
- Local DB reset required on next `db:migrate:local` because
  `0000_init.sql` was edited in place — pre-launch policy, acceptable.
- Manual UI walkthrough pending — user runs `pnpm dev` themselves.

## Intentionally deferred

- Rate limits on invite create / accept (H3 in the review). Per user
  direction, low priority pre-launch.
- Email-scoped invites (L2) — depends on email provider wiring.
- CSRF tokens on form POSTs (L4) — defense-in-depth; currently covered by
  Better Auth's SameSite=Lax session cookie.
