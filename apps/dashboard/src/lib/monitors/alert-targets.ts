/**
 * Pure encode/decode + resolution for a monitor's `alertTargets` column. No IO,
 * so the "who gets alerted" policy is unit-testable on its own; `alerts.tsx`
 * supplies the live membership + group data and does the sending.
 *
 * Storage contract (`monitors.alertTargets`):
 *   - `null`            ⇒ ALL current team members (the default).
 *   - `{ users, groups }` ⇒ those specific members + the members of those
 *     groups, unioned and re-intersected with live memberships at read time
 *     (so a removed member or a deleted group can't leak or linger).
 */

export interface AlertTargets {
  /** Explicitly selected member user ids. */
  users: string[];
  /** Selected `memberGroups` ids; expanded to their members at send time. */
  groups: string[];
}

/** Parse the stored JSON. `null`/malformed ⇒ `null` (= all members, the safe default). */
export function parseAlertTargets(raw: string | null): AlertTargets | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { users?: unknown; groups?: unknown };
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { users: strings(obj.users), groups: strings(obj.groups) };
}

/** Serialize for storage; `null` (= all members) stays `null`. */
export function serializeAlertTargets(
  targets: AlertTargets | null,
): string | null {
  if (targets === null) return null;
  return JSON.stringify({ users: targets.users, groups: targets.groups });
}

/**
 * Build targets from a recipient-form submission. `mode !== "specific"` (i.e.
 * "all members") ⇒ `null`. Otherwise the de-duplicated explicit selection —
 * an empty specific selection is preserved as "nobody" (distinct from "all").
 */
export function buildAlertTargets(
  mode: string,
  userIds: string[],
  groupIds: string[],
): AlertTargets | null {
  if (mode !== "specific") return null;
  return { users: [...new Set(userIds)], groups: [...new Set(groupIds)] };
}

/**
 * Resolve targets to the concrete set of member user ids to notify. Pure: the
 * caller passes the live member ids and the selected groups' member ids.
 *   - `null` ⇒ all members.
 *   - else   ⇒ (explicit users ∪ group members) ∩ live members.
 * The final intersection is what drops stale ids (a member who left, a group
 * member no longer on the team).
 */
export function resolveTargetUserIds(
  targets: AlertTargets | null,
  memberUserIds: string[],
  groupMemberUserIds: string[],
): string[] {
  if (targets === null) return memberUserIds;
  const wanted = new Set([...targets.users, ...groupMemberUserIds]);
  return memberUserIds.filter((id) => wanted.has(id));
}
