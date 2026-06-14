import { and, db, eq } from "void/db";
import { ulid } from "ulid";
import { memberships, teams as teamsTable } from "@schema";

/**
 * SSO/OIDC org-mapping v1 (roadmap 3.3).
 *
 * The mapping question is: a user signs in through the IdP with a verified
 * email — which Wrightful team should they be auto-resolved into? v1 answers
 * it by an owner-configured email domain claimed on the team (`teams.ssoDomain`):
 * if the email's domain equals a team's claimed domain, that's their team.
 *
 * This module is split the same way `provisioning.ts` is: the matching is PURE
 * (domain extraction + equality, unit-tested in isolation, no D1), and the
 * DB-backed resolver composes the pure half with a read of `teams.ssoDomain`
 * and the membership-insert seam. The pure half is the testable surface; the DB
 * half is thin orchestration.
 *
 * Inert by default: nothing calls `resolveTeamForSsoEmail` until the SSO plugin
 * is wired (blocked — see auth.ts / env.ts), and even then it no-ops unless a
 * team has claimed a domain. The pure functions are correct and tested today so
 * the wire is a one-step follow-up.
 */

/**
 * Extract the normalized email domain from an address: the part after the last
 * `@`, lowercased and trimmed. Returns `null` for anything that isn't a
 * plausible `local@domain` (no `@`, empty local part, empty domain, or a domain
 * with no dot). Lowercasing here means callers never have to remember to —
 * email domains are case-insensitive, so `Alice@ACME.com` and `bob@acme.com`
 * must map to the same `acme.com` claim.
 *
 * Sub-domain choice: we do NOT collapse sub-domains. `user@eng.acme.com` yields
 * `eng.acme.com`, which only matches a team that claimed exactly `eng.acme.com`
 * — NOT one that claimed `acme.com`. This is the safe, least-surprising default:
 * a parent-domain claim auto-joining users from every sub-domain is a privilege-
 * escalation footgun (a marketing sub-domain shouldn't inherit an engineering
 * team's access). A deployment that wants sub-domain inheritance can claim each
 * sub-domain explicitly. Documented so the choice is deliberate, not incidental.
 */
export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null; // no "@", or "@" is the first char (empty local part)
  const local = email.slice(0, at);
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!local.trim()) return null;
  if (!domain || !domain.includes(".")) return null;
  // A trailing/leading dot or whitespace-only label is not a real domain.
  if (domain.startsWith(".") || domain.endsWith(".")) return null;
  return domain;
}

/** A team's SSO-domain claim, as read from `teams.ssoDomain`. */
export interface TeamSsoClaim {
  id: string;
  ssoDomain: string | null;
}

/**
 * PURE: given a signed-in user's email and the set of teams' domain claims,
 * return the id of the team whose claimed domain matches the email's domain, or
 * `null` when none match (or the email has no usable domain).
 *
 * Matching is exact, case-insensitive, on the normalized domain (claims are
 * stored normalized by {@link normalizeSsoDomain}; the email domain is
 * normalized by {@link extractEmailDomain}). A team with a null/empty claim
 * never matches. If two teams somehow claimed the same domain (the unique index
 * on `teams.ssoDomain` prevents this at write time, but the function stays
 * total), the first match wins — callers should treat a duplicate claim as a
 * data error, not rely on ordering.
 */
export function resolveTeamForSsoEmail(
  email: string,
  claims: readonly TeamSsoClaim[],
): string | null {
  const domain = extractEmailDomain(email);
  if (!domain) return null;
  for (const claim of claims) {
    if (claim.ssoDomain && claim.ssoDomain === domain) return claim.id;
  }
  return null;
}

/**
 * Validation outcome for an owner-entered SSO domain. A discriminated result —
 * NOT `string | null | "invalid"`, because an `"invalid"` literal would be
 * subsumed by `string` and collapse the union. `ok: true` carries the
 * normalized domain (host only, lowercased) or `null` for "clear the claim"
 * (blank input); `ok: false` means the input isn't a bare domain.
 */
export type SsoDomainParse =
  | { ok: true; domain: string | null }
  | { ok: false };

/**
 * PURE: normalize + validate an owner-entered SSO domain for storage.
 *
 * Accepts a bare host (`acme.com`, `eng.acme.com`) — lowercased and trimmed.
 * Tolerates a pasted `https://acme.com/...` by stripping a leading scheme, a
 * leading `@`, and any path/query, since owners paste loosely. Blank ⇒
 * `{ ok: true, domain: null }` (clear the claim). Anything that still isn't a
 * plausible domain (no dot, spaces, leading/trailing dot) ⇒ `{ ok: false }` so
 * the settings action can show a field error rather than persist a value that
 * can never match an email domain.
 */
export function normalizeSsoDomain(raw: string): SsoDomainParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, domain: null };
  // Strip a pasted scheme, a leading "@", and any path/query/port so the stored
  // value is a bare host comparable to an email's domain.
  let host = trimmed
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:.*$/, "");
  host = host.trim();
  if (!host || host.includes(" ")) return { ok: false };
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    return { ok: false };
  }
  // Conservative host charset: labels of letters/digits/hyphens separated by
  // dots. Rejects anything with characters that can't appear in an email domain.
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      host,
    )
  ) {
    return { ok: false };
  }
  return { ok: true, domain: host };
}

// ---------- DB-backed resolver (thin orchestration over the pure half) ----------

/**
 * Auto-resolve a user into the team that claimed their SSO email domain, if
 * any, by inserting an owner-less `member` membership — reusing the same
 * `memberships` insert seam directed invites use. Idempotent: a no-op when the
 * email maps to no team OR the user is already a member of that team.
 *
 * This is the runtime entry point the SSO sign-in hook will call once the
 * plugin is wired (BLOCKED — see auth.ts). It is intentionally NOT referenced
 * anywhere yet, so it adds zero behavior to the live email/password + GitHub
 * flows. Kept here, fully built and reading the pure {@link resolveTeamForSsoEmail},
 * so finishing the IdP wire is a one-line call from the sign-in hook.
 *
 * Returns the resolved `teamId` (whether newly joined or already a member), or
 * `null` when the email maps to no claimed team.
 */
export async function joinTeamForSsoEmail(
  userId: string,
  email: string,
): Promise<string | null> {
  const claims = await db
    .select({ id: teamsTable.id, ssoDomain: teamsTable.ssoDomain })
    .from(teamsTable);
  const teamId = resolveTeamForSsoEmail(email, claims);
  if (!teamId) return null;

  // Already a member of this team? No-op. `memberships` has a unique
  // (userId, teamId) index, so this composite read is at most one row.
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
    .limit(1);
  if (existing[0]) return teamId;

  await db.insert(memberships).values({
    id: ulid(),
    userId,
    teamId,
    role: "member",
    createdAt: Math.floor(Date.now() / 1000),
  });
  return teamId;
}
