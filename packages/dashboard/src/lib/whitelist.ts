/**
 * Parse a comma-separated allow-list string into a normalized array of
 * lowercased, trimmed entries. Empty / whitespace-only entries are dropped,
 * and `null` / `undefined` collapse to `[]` so callers can treat "unset" and
 * "set to empty string" identically.
 */
export function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export interface WhitelistSubject {
  /** Verified email (from GitHub). Compared against `allowedDomains`. */
  email: string;
  /** Lowercased org logins the user belongs to. Compared against `allowedOrgs`. */
  orgs: string[];
}

export interface WhitelistConfig {
  allowedOrgs: string[];
  allowedDomains: string[];
}

/**
 * True if the subject matches either whitelist. Empty allow-lists contribute
 * nothing — the caller decides whether an entirely empty config means
 * "accept everyone" (instance whitelist unset) or "reject everyone" (team
 * invite not configured).
 */
export function matchesWhitelist(
  subject: WhitelistSubject,
  config: WhitelistConfig,
): boolean {
  if (config.allowedDomains.length > 0) {
    const at = subject.email.lastIndexOf("@");
    if (at >= 0) {
      const domain = subject.email.slice(at + 1).toLowerCase();
      if (config.allowedDomains.includes(domain)) return true;
    }
  }
  if (config.allowedOrgs.length > 0) {
    for (const org of subject.orgs) {
      if (config.allowedOrgs.includes(org.toLowerCase())) return true;
    }
  }
  return false;
}
