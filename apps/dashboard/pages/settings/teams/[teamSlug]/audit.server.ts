import { defineHandler, type InferProps } from "void";
import { db, desc, eq, sql } from "void/db";
import { z } from "zod";
import { auditLog } from "@schema";
import { getUsersByIds } from "@/lib/auth-users";
import { requireRoleScope } from "@/lib/settings-scope";

// withValidator's TypedHandler doesn't auto-await the handler return like the
// plain `defineHandler` overload does — wrap in `Awaited<>` (mirrors tests.server.ts).
export type Props = Awaited<InferProps<typeof loader>>;

const PAGE_SIZE = 50;

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string;
  /** Resolved actor display name, falling back to the raw id if the user is gone. */
  actorName: string;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  /** Parsed metadata bag (or null when absent / unparseable). */
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Settings → Team → Audit log (roadmap 3.2). OWNER-ONLY — gated on
 * `manageMembers`, the owner-only capability, so a plain member (who has
 * `viewSettings`) 404s here just like a viewer does on every settings page. The
 * log is the privileged record of who did what; it stays behind the same
 * owner-only gate the plan specifies.
 *
 * Reverse-chron (`ORDER BY createdAt DESC`), offset-paginated the same way the
 * tests catalog is, with actor display names hydrated via `getUsersByIds`.
 */
export const loader = defineHandler.withValidator({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
  }),
})(async (c, { query }) => {
  const { team } = await requireRoleScope(c, "manageMembers");
  const requestedPage = query.page ?? 1;

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(auditLog)
    .where(eq(auditLog.teamId, team.id));
  const totalCount = totalRows[0]?.value ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.teamId, team.id))
    // `createdAt` is epoch SECONDS, so several rows routinely share a value;
    // append the ULID `id` (lexicographically time-ordered) as a stable
    // tiebreak so offset paging can't duplicate/skip rows across pages —
    // matching the (createdAt, id) convention in export.ts / run-diff.ts.
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(PAGE_SIZE)
    .offset(offset);

  // Resolve actor display names from the void-owned `user` table via the
  // auth-users seam. A deleted user (or the "unknown" sentinel) falls back to
  // the raw id so the row stays meaningful.
  const profiles = await getUsersByIds([
    ...new Set(rows.map((r) => r.actorUserId)),
  ]);
  const entries: AuditEntry[] = rows.map((r) => {
    const profile = profiles.get(r.actorUserId);
    return {
      id: r.id,
      action: r.action,
      actorUserId: r.actorUserId,
      actorName: profile?.name ?? r.actorUserId,
      actorEmail: profile?.email ?? null,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: parseMetadata(r.metadata),
      createdAt: r.createdAt,
    };
  });

  const fromRow = totalCount === 0 ? 0 : offset + 1;
  const toRow = offset + entries.length;

  return {
    team,
    entries,
    totalCount,
    currentPage,
    totalPages,
    fromRow,
    toRow,
  };
});
