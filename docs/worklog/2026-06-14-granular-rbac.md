# 2026-06-14 — Granular RBAC + member-role editing (roadmap 3.1)

## What changed

Widened the team membership model from two roles (`owner | member`) to three
(`owner | member | viewer`) and replaced the scattered `role === "owner"` /
"any member" gates with a single capability helper, `can(role, action)`. Team
owners can now edit a member's role and remove members from the new Members
settings page, and choose the role an invite grants. The whole change is a TYPE
widening on an existing `text()` column — **no migration**.

The headline design decision: `member` keeps **exactly** its pre-3.1
capabilities. In the pre-3.1 codebase every mutation (key minting, config
writes, project creation, monitors, quarantine, member management, team delete)
was already owner-gated; a `member` could only _read_ the settings pages. So
the capability matrix maps `member → viewSettings` only — granting members
`writeConfig`/`mintKeys` would have silently UPGRADED every existing member
(a security regression), and removing `viewSettings` would have downgraded
them. `viewer` is a member for all READ paths (run/test data, realtime) but
holds no settings capability at all — a viewer reads the dashboard and 404s on
every settings surface.

## The capability matrix (`src/lib/roles.ts`)

| capability      | owner | member | viewer | rationale                                     |
| --------------- | :---: | :----: | :----: | --------------------------------------------- |
| `viewSettings`  |  ✅   |   ✅   |   ❌   | members read settings today; viewers don't    |
| `manageMembers` |  ✅   |   ❌   |   ❌   | owner-only today (invite mint, member remove) |
| `mintKeys`      |  ✅   |   ❌   |   ❌   | owner-only today (`requireOwnedProjectScope`) |
| `writeConfig`   |  ✅   |   ❌   |   ❌   | owner-only today (`requireOwnerScope`)        |
| `deleteTeam`    |  ✅   |   ❌   |   ❌   | owner-only; the chosen owner discriminant     |

`deleteTeam` is owner-exclusive, so `resolveOwnedTeam` gates on it to preserve
the exact owner-only semantics every existing caller relies on. The matrix is
defined explicitly (a full row per role, not a hierarchy) so a future edit to
one cell can't silently grant a capability, and is exhaustively unit-tested
(3 roles × 5 capabilities + invariants).

## The race-safe last-owner guard

A team must never be left with zero owners. The guard rides INSIDE the write —
an owner-count subquery in the UPDATE/DELETE `WHERE`, never a check-then-write —
exactly as the pre-existing `leaveTeam` did. The shared predicate
`notLastOwner(teamId)` (`src/lib/members-repo.ts`) is
`or(role != 'owner', (select count(*) … role='owner') > 1)`:

- **demote** (`setMemberRole`): the guard is applied only when the new role is
  NOT owner (promoting/keeping owner never reduces the owner count). Demoting
  the sole owner matches 0 rows; `.returning()` is re-checked against a cheap
  existence read to tell "blocked by guard (lastOwner)" apart from "row already
  gone (noop)", surfacing the right inline banner.
- **remove** (`removeMemberGuarded`): same predicate in the DELETE WHERE, same
  `.returning()` disambiguation. Self-removal is still blocked here (use Leave
  team), but removing _another_ owner can no longer strand the team.
- **leave** (`leaveTeam`): refactored to reuse `notLastOwner` instead of an
  inlined subquery.

Because the predicate is in the statement, D1 serializes concurrent writes and
the second one matches 0 rows — two concurrent demotions/removals can never both
land. The guard's WHERE shape is unit-tested against the `void/db` stub.

## Files

| File                                                                | Purpose                                                                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/db/schema.ts`                                       | Widen `MembershipRole` union to add `"viewer"` (type-only; no DDL).                                                                                                                    |
| `apps/dashboard/src/lib/roles.ts`                                   | **New.** Pure `can(role, action)` capability helper + matrix, `ASSIGNABLE_ROLES`, `ROLE_DESCRIPTIONS`.                                                                                 |
| `apps/dashboard/src/lib/members-repo.ts`                            | **New.** Shared `roleSchema` (Zod), `notLastOwner` predicate, race-safe `setMemberRole` / `removeMemberGuarded`.                                                                       |
| `apps/dashboard/src/lib/settings-scope.ts`                          | Re-key `gateTeamScope` on a `Capability` (was a role string); add `requireRoleScope(c, action, hereFor?)`; `resolveOwnedTeam` now gates on `deleteTeam`.                               |
| `apps/dashboard/pages/settings/teams/[teamSlug]/members.server.ts`  | Loader gated on `viewSettings`; new `updateMemberRole` action; `removeMember`/`revokeInvite` gated on `manageMembers` + last-owner-safe; surface `assignableRoles`/`roleDescriptions`. |
| `apps/dashboard/pages/settings/teams/[teamSlug]/members.tsx`        | Per-member-row role selector + Save (owner-only), invite-form role selector, role-description hint. Reads + renders the existing `membersError` banner.                                |
| `apps/dashboard/pages/settings/teams/[teamSlug]/general.server.ts`  | Loader: `requireMemberScope` → `requireRoleScope(c, "viewSettings")`.                                                                                                                  |
| `apps/dashboard/pages/settings/teams/[teamSlug]/projects.server.ts` | Same.                                                                                                                                                                                  |
| `apps/dashboard/pages/settings/teams/[teamSlug]/usage.server.ts`    | Same.                                                                                                                                                                                  |
| `apps/dashboard/routes/api/teams/[teamSlug]/invites.ts`             | Accept a validated `role` (defaults to `member`); was hardcoded `"member"`.                                                                                                            |
| `apps/dashboard/routes/api/github/setup.ts`                         | `gateTeamScope(..., "owner")` → `"writeConfig"` (capability-keyed; owner-only, behavior preserved).                                                                                    |
| `apps/dashboard/src/__tests__/roles.test.ts`                        | **New.** Full `can()` matrix + invariants + metadata.                                                                                                                                  |
| `apps/dashboard/src/__tests__/members-repo.test.ts`                 | **New.** Last-owner guard shape + demote/remove branches + `roleSchema`.                                                                                                               |
| `apps/dashboard/src/__tests__/settings-scope.test.ts`               | Updated for the capability-keyed gate; added viewer coverage.                                                                                                                          |

## Notes / details

- **No migration.** The `memberships.role` / `teamInvites.role` columns are
  `text("role").$type<MembershipRole>()`; widening the TS union is compile-time
  only. `git status` on `db/migrations/` is clean; `void db generate` was NOT
  run.
- **Viewers can still read the dashboard.** The tenant context
  (`resolveTenantBundleForUser`) and realtime topic gates require _membership_
  (any role); a viewer is a member row, so no read/realtime path changed.
- **UI is no-JS-friendly.** The role pickers are native `<select>`s posting real
  form values (not the JS-only Base UI `ui/select`), matching the page's
  existing `<form action method="post">` + `?membersError=` redirect-then-banner
  idiom. The error banner was already read + rendered by the page — confirmed
  it's a live channel (not a repeat of the 2.2 dead-channel bug).
- **`ASSIGNABLE_ROLES` is an `as const` tuple** with a bidirectional type-level
  exhaustiveness guard against `MembershipRole`, so `z.enum` accepts it without
  a cast and the list can't drift from the union.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (0 errors).
- `pnpm --filter @wrightful/dashboard test` — **1065 passed** (96 files; was
  1026 in 2.6, +39 from the new role/guard tests and the rewritten
  settings-scope test).
- `pnpm --filter @wrightful/dashboard run check` — **0 errors**, 78 warnings
  (all pre-existing `no-unsafe-type-assertion` style warnings elsewhere; net
  zero new warnings — `check:fix` run first).
