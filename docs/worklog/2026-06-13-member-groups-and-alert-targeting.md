# 2026-06-13 — Member groups + per-monitor alert recipients

Extends the monitor alerting from "always all team members"
(`2026-06-13-email-verification-and-monitor-alerts.md`) to a chooseable
recipient set, and adds **member groups** as a reusable team primitive that the
recipient picker (and future features) can target.

## What changed

### Member groups (new team primitive)

- **Schema**: `memberGroups` (id, teamId, name, createdBy, timestamps; unique
  `(teamId, name)`) + `memberGroupMembers` (groupId, userId; composite PK).
  Team-scoped (membership is team-scoped). Migration
  `20260613164410_complete_wrecking_crew.sql`.
- **Repo** `src/lib/member-groups.ts`: `listGroups` (with member ids),
  `listUserIdsInGroups`, `createGroup`, `renameGroup`, `setGroupMembers`,
  `deleteGroup`. All reads/writes scoped by `teamId`; `setGroupMembers` replaces
  membership wholesale and **intersects with the team's live members** so a
  stale/non-member id is never stored.
- **UI** `pages/settings/teams/[teamSlug]/groups.{server,tsx}`: a **Team
  Settings → Groups** page — list, create, edit (rename + members), delete.
  Owners manage; other members see a read-only list. Server-rendered forms (no
  island), mirroring the members page. Nav link added in `app-layout.tsx`.
- Shared helper `listTeamMembers(teamId)` extracted into `auth-users.ts` (the
  members-page inline pattern), reused by groups + the picker + alert resolution.

### Per-monitor alert recipients

- **Schema**: `monitors.alertTargets` (JSON text). `null` = **all team members**
  (the default); else `{ users: string[], groups: string[] }`. Migration
  `20260613161750_empty_richard_fisk.sql` (additive column).
- **Pure model** `src/lib/monitors/alert-targets.ts`: `parseAlertTargets` /
  `serializeAlertTargets` / `buildAlertTargets` (form mode → value) /
  `resolveTargetUserIds` (`null` ⇒ all; else `(users ∪ group-members) ∩ live
members`). No IO — fully unit-tested.
- **Resolution**: `alerts.tsx` `resolveRecipients(monitor)` now expands
  `alertTargets` — `listTeamMembers` + `listUserIdsInGroups`, intersected — so a
  removed member or deleted group can't leak or linger.
- **UI**: an owner-only "Alert recipients" section on the monitor detail page —
  radio **All team members** vs **Specific members or groups**, with group +
  member checkboxes. "All" stores `null` (new members auto-included). Backed by
  a `setAlertRecipients` action + `setMonitorAlertTargets` repo fn.

## Notes / decisions

- **Default unchanged**: a new monitor has `alertTargets = null` = all members,
  so existing behavior is preserved; narrowing is opt-in.
- **Groups are generic on purpose** (not alert-specific) so notification routing
  / access scoping can reuse them later; the only consumer today is alert
  targeting.
- The recipient picker is server-rendered: the group/member checkboxes are
  always present and only consulted when mode = "specific" (no JS needed). An
  empty "specific" selection means nobody (distinct from "all"/`null`).
- Stale-id safety is enforced twice: at write (`setGroupMembers` intersects with
  live members) and at read (`resolveTargetUserIds` re-intersects).

## Verification

- `pnpm --filter @wrightful/dashboard test` — **903 passed** (86 files), incl.
  10 new `alert-targets` tests (parse/serialize round-trip, build modes,
  resolve: all / union / stale-drop / empty-specific).
- `pnpm --filter @wrightful/dashboard check` — **0 errors** (43 pre-existing
  warnings); `typecheck` clean; `build` succeeds (client + worker).
- Manual follow-up on first deploy with email: create a group, set a monitor to
  notify it, confirm a down alert reaches exactly the group's members.
