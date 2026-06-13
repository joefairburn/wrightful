/**
 * URL policy for `http` (uptime) monitors — PURE (no `void/*` imports) so it is
 * unit-tested directly and reused across both validation points:
 *   - **write/config path** — the `HttpMonitorConfigSchema` URL refinement (and,
 *     since the executor parses the stored config through that same schema, the
 *     entered URL is re-vetted every run, not just at save time);
 *   - **read path** — `runHttpCheck` re-checks the FINAL url after a followed
 *     redirect (defense in depth: a redirect can land on a host the config-time
 *     check never saw).
 *
 * What it enforces, and WHY each rule earns its place:
 *   - **scheme allowlist** (`http:` / `https:`) — a check is an outbound web
 *     request; `file:`/`data:`/`blob:` etc. are never a monitoring target.
 *   - **no credentials in the URL** — `https://user:pass@host` would leak a
 *     secret into a stored monitor row + every result; force header-based auth
 *     later instead.
 *   - **reject literal private / loopback / link-local / metadata hosts** — this
 *     is the SSRF guard. Cloudflare Workers egress already can't reach these
 *     (so it is mostly fail-fast UX + defense in depth), but rejecting them at
 *     the boundary keeps a confusing "it just times out" experience from ever
 *     reaching a user, and hard-codes the intent so a future non-Workers runner
 *     inherits the guard. Monitoring one's OWN public dashboard URL is fine and
 *     allowed — handling a check never triggers another check, so there is no
 *     recursion to guard against.
 *   - **length caps** — bound the stored row + a pathological host.
 */

/** The verdict: `ok`, or a user-facing `reason` the form surfaces inline. */
export type UrlPolicyResult = { ok: true } | { ok: false; reason: string };

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 255;

/**
 * Parse an IPv4 dotted-quad to its four octets, or `null` if `host` is not a
 * bare IPv4 literal (a DNS name like `example.com` returns `null` and is
 * allowed — we only block literal IPs, since a name resolving into a private
 * range is caught by the runtime's own egress rules, not statically here).
 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** True when an IPv4 literal falls in a private / loopback / link-local range. */
function isBlockedIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local + metadata 169.254.0.0/16
  if (a >= 224) return true; // multicast / reserved 224.0.0.0+
  return false;
}

/**
 * True when an IPv6 literal (brackets already stripped) is loopback / unique-
 * local / link-local / unspecified, including the IPv4-mapped forms. A coarse
 * prefix check — enough for a defense-in-depth guard.
 */
function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (
    // fe80::/10 is the second byte 0x80–0xbf, i.e. textual prefix fe8/fe9/fea/feb
    // — `fe8` (not `fe80`) so fe81::–fe8f:: are caught, not just fe80::.
    h.startsWith("fe8") ||
    h.startsWith("fe9") ||
    h.startsWith("fea") ||
    h.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped / -compatible (e.g. ::ffff:127.0.0.1) — re-check the tail as v4.
  const tail = h.split(":").pop() ?? "";
  if (tail.includes(".")) return isBlockedIpv4(tail);
  return false;
}

/** True when the host is one we never allow a monitor to target. */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // WHATWG `URL.hostname` keeps IPv6 in brackets — strip them before matching.
  if (host.startsWith("[") && host.endsWith("]")) {
    return isBlockedIpv6(host.slice(1, -1));
  }
  return isBlockedIpv4(host);
}

/**
 * Validate a monitor target URL against the policy. Returns `{ ok: true }` or a
 * single user-facing `reason`. Pure and synchronous — the same call serves the
 * zod refinement (write path) and the executor's pre-fetch re-check (read path).
 */
export function checkUrlPolicy(raw: string): UrlPolicyResult {
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "URL is too long" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Enter a valid URL" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "URLs may not contain a username or password" };
  }
  const host = url.hostname;
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return { ok: false, reason: "URL host is invalid" };
  }
  if (isBlockedHost(host)) {
    return {
      ok: false,
      reason: "Private, loopback, and link-local addresses can't be monitored",
    };
  }
  return { ok: true };
}
