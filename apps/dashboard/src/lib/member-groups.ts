/**
 * Repository for `memberGroups` — named, team-scoped sets of members (see the
 * schema doc-comment). All reads/writes are scoped by `teamId` so a caller can
 * never touch another team's groups. Group membership is replaced wholesale by
 * `setGroupMembers` (the edit form posts the full desired set), and is always
 * intersected with the team's CURRENT members so a stale user id can't be
 * stored.
 */
import { and, db, eq, inArray } from "void/db";
import { ulid } from "ulid";
import { memberGroupMembers, memberGroups } from "@schema";
import { listTeamMembers } from "@/lib/auth-users";

export interface MemberGroupSummary {
  id: string;
  name: string;
  memberIds: string[];
}

/** All groups for a team, each with its member ids, sorted alphabetically by name. */
export async function listGroups(
  teamId: string,
): Promise<MemberGroupSummary[]> {
  const groups = await db
    .select({ id: memberGroups.id, name: memberGroups.name })
    .from(memberGroups)
    .where(eq(memberGroups.teamId, teamId))
    .orderBy(memberGroups.name);
  if (groups.length === 0) return [];

  const links = await db
    .select({
      groupId: memberGroupMembers.groupId,
      userId: memberGroupMembers.userId,
    })
    .from(memberGroupMembers)
    .where(
      inArray(
        memberGroupMembers.groupId,
        groups.map((g) => g.id),
      ),
    );
  const byGroup = new Map<string, string[]>();
  for (const l of links) {
    const list = byGroup.get(l.groupId) ?? [];
    list.push(l.userId);
    byGroup.set(l.groupId, list);
  }
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: byGroup.get(g.id) ?? [],
  }));
}

/** Distinct user ids belonging to any of `groupIds` within the team. */
export async function listUserIdsInGroups(
  teamId: string,
  groupIds: string[],
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({ userId: memberGroupMembers.userId })
    .from(memberGroupMembers)
    .innerJoin(memberGroups, eq(memberGroups.id, memberGroupMembers.groupId))
    .where(
      and(
        eq(memberGroups.teamId, teamId),
        inArray(memberGroupMembers.groupId, groupIds),
      ),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

/** Create a group and set its initial members (intersected with live members). */
export async function createGroup(
  teamId: string,
  name: string,
  userIds: string[],
  createdBy: string,
  now: number,
): Promise<string> {
  const id = ulid();
  await db.insert(memberGroups).values({
    id,
    teamId,
    name,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  await replaceMembers(teamId, id, userIds);
  return id;
}

/** Rename a group (scoped to the team). */
export async function renameGroup(
  teamId: string,
  groupId: string,
  name: string,
  now: number,
): Promise<void> {
  await db
    .update(memberGroups)
    .set({ name, updatedAt: now })
    .where(and(eq(memberGroups.id, groupId), eq(memberGroups.teamId, teamId)));
}

/** Replace a group's members with `userIds` (intersected with live members). */
export async function setGroupMembers(
  teamId: string,
  groupId: string,
  userIds: string[],
  now: number,
): Promise<void> {
  // Verify the group belongs to the team before touching its membership.
  const owned = await db
    .select({ id: memberGroups.id })
    .from(memberGroups)
    .where(and(eq(memberGroups.id, groupId), eq(memberGroups.teamId, teamId)))
    .limit(1);
  if (owned.length === 0) return;
  await replaceMembers(teamId, groupId, userIds);
  await db
    .update(memberGroups)
    .set({ updatedAt: now })
    .where(eq(memberGroups.id, groupId));
}

/** Delete a group (its membership rows cascade). */
export async function deleteGroup(
  teamId: string,
  groupId: string,
): Promise<void> {
  await db
    .delete(memberGroups)
    .where(and(eq(memberGroups.id, groupId), eq(memberGroups.teamId, teamId)));
}

/**
 * Wholesale-replace a group's membership with the intersection of `userIds` and
 * the team's CURRENT members — so a stale/non-member id is never stored.
 */
async function replaceMembers(
  teamId: string,
  groupId: string,
  userIds: string[],
): Promise<void> {
  const liveIds = new Set((await listTeamMembers(teamId)).map((m) => m.userId));
  const valid = [...new Set(userIds)].filter((id) => liveIds.has(id));
  await db
    .delete(memberGroupMembers)
    .where(eq(memberGroupMembers.groupId, groupId));
  if (valid.length > 0) {
    await db
      .insert(memberGroupMembers)
      .values(valid.map((userId) => ({ groupId, userId })));
  }
}
