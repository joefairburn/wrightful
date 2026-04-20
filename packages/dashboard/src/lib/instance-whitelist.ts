import { env } from "cloudflare:workers";
import { parseList, type WhitelistConfig } from "@/lib/whitelist";

/**
 * Resolve the instance-level signup whitelist from env vars. Both entries
 * are optional; when either has at least one value, the instance is
 * considered "gated" and new GitHub users must match it.
 */
export function getInstanceWhitelist(): WhitelistConfig {
  return {
    allowedOrgs: parseList(env.SIGNUP_GITHUB_ORGS),
    allowedDomains: parseList(env.SIGNUP_EMAIL_DOMAINS),
  };
}

export function hasInstanceWhitelist(): boolean {
  const cfg = getInstanceWhitelist();
  return cfg.allowedOrgs.length > 0 || cfg.allowedDomains.length > 0;
}
