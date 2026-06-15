# 2026-06-14 — Audit logs (roadmap 3.2)

## What changed

Added an append-only, team-scoped **audit log**: one `auditLog` table, one
best-effort `recordAudit(c, …)` helper, instrumentation on every concentrated
privileged mutation (invites, members, API keys, team, projects), and an
owner-only reverse-chron viewer page at
`/settings/teams/:teamSlug/audit` linked into the team settings nav.

The audit instrumentation hooks into the same mutating actions the 3.1 RBAC
commit (`a3f0773`) touched — `members.server.ts`, the invites/keys JSON routes,
`general.server.ts`, the provisioning call sites — so the audit write sits
immediately next to the mutation it records.

## Schema (one additive migration)

`db/schema.ts` gains the `auditLog` table + `AuditLogRow` type alias.
`vp exec void db generate` produced exactly one migration,
`db/migrations/20260614094343_mighty_vargas.sql`, which is **purely additive**:

```sql
CREATE TABLE `auditLog` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`projectId` text,
	`actorUserId` text NOT NULL,
	`action` text NOT NULL,
	`targetType` text,
	`targetId` text,
	`metadata` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `auditLog_team_createdAt_idx` ON `auditLog` (`teamId`,`createdAt`);
```

No DROP / ALTER of any existing table — a single `CREATE TABLE` + `CREATE INDEX`.

### onDelete choices — why an audit row outlives the entity it records

| Column        | FK                         | onDelete       | Why                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teamId`      | → `teams.id`               | **`cascade`**  | The audit log is _team_-scoped. When the team itself is deleted there is no longer anyone who could read its log (the viewer is owner-only, and the team's memberships cascade away too), so retaining orphaned audit rows for a dead team buys nothing. Cascade is acceptable **and** simplest. The `team.delete` row is still captured because `recordAudit` runs **synchronously before** the delete batch. |
| `projectId`   | → `projects.id` (nullable) | **`set null`** | A project delete must **not** cascade-delete the rows that record it — the "project deleted" entry is exactly the row an owner wants to keep. The FK nulls the column on project delete and the row persists under its team.                                                                                                                                                                                   |
| `actorUserId` | (none)                     | —              | Logical FK to the void-managed `user.id`, matching `memberships.userId` / `monitors.createdBy`.                                                                                                                                                                                                                                                                                                                |

A `project.delete` row therefore survives the project: `recordAudit` is called
**before** the delete statement, capturing the project's slug in `targetId` and
its name in `metadata`, so the row is still meaningful after `projectId` is
nulled by the cascade.

## `src/lib/audit.ts` (new)

- `AUDIT_ACTIONS` — the canonical action-string constants (`invite.mint`,
  `member.role_change`, `key.revoke`, `team.delete`, `project.create`, …) so
  call sites don't stringly-drift. `AuditAction` / `AuditTargetType` unions.
- `buildAuditRow(actorUserId, input, now?)` — **pure** row builder (ULID id,
  epoch-seconds `createdAt`, projectId/targetType/targetId default to null,
  metadata JSON-serialized in one place). Unit-testable with no DB / context.
- `recordAudit(c, { teamId, projectId?, action, targetType?, targetId?, metadata? })`
  — resolves the actor via `requireAuth(c)`, inserts one row.
  **Best-effort**: the insert is wrapped in `try/catch` and a failure is
  `logger.error`-ed and swallowed, so a broken audit write can NEVER fail the
  mutation it records. **Synchronous** (plain awaited insert, never
  `waitUntil` / fire-and-forget) — workerd drops orphaned post-response
  promises, and deletes must capture context before their cascade.

## Instrumented actions

| Action string        | Where                                                                      | Notes                                                                                   |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `invite.mint`        | `routes/api/teams/[teamSlug]/invites.ts`                                   | after insert; target = email/`@login`/"open invite link", role in metadata              |
| `invite.revoke`      | `members.server.ts#revokeInvite`                                           | `.returning()` — only audited on a genuine delete (no-op id writes nothing)             |
| `invite.accept`      | `routes/api/invites/[inviteId]/accept.ts`                                  | only the genuine join branch (idempotent re-accept writes nothing); actor = invitee     |
| `member.role_change` | `members.server.ts#updateMemberRole`                                       | only when `setMemberRole` returns `ok` (no-op / last-owner-block writes nothing)        |
| `member.remove`      | `members.server.ts#removeMember`                                           | only when `removeMemberGuarded` returns `ok`                                            |
| `member.leave`       | `members.server.ts#leaveTeam`                                              | only on a successful self-delete; team (+ log) survives, so awaited after the delete    |
| `key.mint`           | `routes/api/teams/[teamSlug]/p/[projectSlug]/keys.ts`                      | project-scoped; target = label, keyPrefix in metadata                                   |
| `key.revoke`         | `keys.server.ts#revokeKey`                                                 | `.returning()` — only on a genuine state change (idempotent revoke writes nothing)      |
| `team.rename`        | `general.server.ts#updateGeneral`                                          | after the update; before/after name+slug in metadata                                    |
| `team.delete`        | `general.server.ts#deleteTeam`                                             | **before** the delete batch (synchronous); row cascades away with the team              |
| `project.create`     | `routes/api/teams/[teamSlug]/projects.ts` **and** `projects/new.server.ts` | both the JSON route and the form action (shared `createProjectForTeam` seam has no `c`) |
| `project.delete`     | `keys.server.ts#deleteProject`                                             | **before** the delete batch; slug/name captured so the row survives the cascade-null    |

Guard discipline: every audit write sits on the **success** path (uses
`.returning()` / the repo result) so a no-op or a guard-rejected mutation never
writes a misleading row, and deletes audit **before** the delete runs.

## Viewer page (new)

- `pages/settings/teams/[teamSlug]/audit.server.ts` — **owner-only**, gated on
  `requireRoleScope(c, "manageMembers")` (the owner-only capability — a plain
  member who holds `viewSettings` 404s here, same leak-safe 404-not-403 rule as
  every settings page). Reverse-chron (`ORDER BY createdAt DESC`), offset
  pagination (50/page) matching `tests.server.ts`; actor display names resolved
  via `getUsersByIds` (falls back to the raw id for a deleted user).
- `pages/settings/teams/[teamSlug]/audit.tsx` — presentational (no client
  island): `ui/table` with action / actor / target / when columns, action
  badges, `formatRelativeTime`, and the shared `TablePaginationFooter`. Empty
  state when there's no activity.
- `src/components/app-layout.tsx` — "Audit log" nav link added to the team
  settings group, rendered only when the viewer owns the expanded team
  (`selectedTeam.role === "owner"`), so a member never sees a link they can't
  open (the page 404s regardless).

## Tests

`src/__tests__/audit.test.ts` (new, 7 tests), using the `void/db`-stub idiom
from `members-repo.test.ts` / `quarantine-repo.test.ts`:

- `buildAuditRow` — action constant, actor, ULID id + epoch `createdAt`, the
  null defaults, metadata JSON serialization, projectId pass-through.
- `recordAudit` — inserts exactly one row with the resolved actor; a **throwing
  db does not propagate** (resolves `undefined`) and routes the failure to
  `logger.error`; the helper returns a Promise (awaitable / synchronous, not
  fire-and-forget — the property the delete-before-cascade ordering relies on).

## Verification

| Check                                              | Result                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm --filter @wrightful/dashboard run typecheck` | clean                                                                          |
| `vp exec void db generate`                         | one additive migration (CREATE TABLE + INDEX only)                             |
| `pnpm --filter @wrightful/dashboard test`          | **1072 passed** (97 files) — was 1065 at 3.1, +7 audit                         |
| `pnpm --filter @wrightful/dashboard run check`     | **0 errors**, 78 warnings (all pre-existing — `audit.server.ts` produces none) |

## Notes / unsure

- **Team-create is intentionally NOT audited.** The plan lists "team rename /
  delete" (not create); team creation is also reachable by a brand-new user
  who isn't yet an owner of anything, so there's no team-scoped log to write
  into at that moment. Project create _is_ audited at both its call sites.
- The `team.delete` row is genuinely transient (it cascades with the team). It
  is still recorded synchronously before the cascade per the plan, so the
  actor/confirmation context is captured and workerd can't drop it — but it
  won't be readable after the team is gone, which is the documented, accepted
  trade-off for a team-scoped log.

## Adversarial review + fixes

Reviewed across coverage/correctness, best-effort robustness, schema/cascade,
and page isolation. The schema/cascade design (teamId cascade, projectId
set-null so delete records survive), the best-effort try/catch, and the page's
owner-only tenant scoping all came back clean. Three findings confirmed (2
medium, 1 low) and fixed:

- **(medium) primary invite-accept path was un-audited.** Only the programmatic
  `/api/invites/:id/accept` route recorded `invite.accept`; the real path — the
  emailed `/invite/:token` link → join form action — created the membership but
  wrote no audit row. Added a `recordAudit` on that action's genuine-join success
  path (after the atomic insert+delete, not on the already-member early return),
  mirroring the API route.
- **(medium) audit pagination had no stable tiebreak.** `createdAt` is epoch
  seconds, so a page boundary inside a same-second group could duplicate/skip
  rows. Added `desc(auditLog.id)` (ULID, time-ordered) as the secondary sort,
  matching the `(createdAt, id)` convention used by export.ts / run-diff.ts.
- **(low)** the best-effort failure log now includes `targetType`/`targetId`.

Re-verified: typecheck clean, **1072 tests pass** (97 files), `vp check` 0 errors.
