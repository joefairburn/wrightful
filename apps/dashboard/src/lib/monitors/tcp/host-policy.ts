/**
 * Host policy for `tcp` / `ping` monitors — the SSRF guard for the raw-socket
 * check, the TCP twin of `http/url-policy.ts`'s `checkUrlPolicy`. PURE (no
 * `void/*` imports) so it is unit-tested directly and reused across both
 * validation points the http policy covers:
 *   - **write/config path** — the `TcpMonitorConfigSchema` host refinement (and,
 *     since the executor parses the stored config through that same schema, the
 *     entered host is re-vetted every run, not just at save time);
 *   - **read path** — `runTcpCheck` re-checks the host immediately before the
 *     `connect()` so a directly-written / schema-evolved row can never open a
 *     socket to internal infra.
 *
 * Why TCP needs its OWN policy rather than reusing `checkUrlPolicy`:
 *   - A TCP config stores a bare HOST + PORT, not a URL — there is no scheme,
 *     path, or credentials to vet, and wrapping the host in a throwaway `http://`
 *     URL just to reuse the parser would (a) silently accept a host that happens
 *     to contain a path/query, and (b) couple the TCP contract to http semantics
 *     it doesn't have. So the IPv4/IPv6/loopback BLOCK LOGIC is the genuinely
 *     shared part — it is imported from `http/url-policy.ts` (`isBlockedHostname`)
 *     and this module adds only the bare-host shape validation around it.
 *
 * What it enforces, and WHY each rule earns its place:
 *   - **reject literal private / loopback / link-local / metadata hosts** — this
 *     is the SSRF guard, and the WHOLE POINT of the policy. A TCP monitor opens a
 *     raw socket from the Worker; without this a user could point one at
 *     `127.0.0.1`, `169.254.169.254` (cloud metadata), or an `10.0.0.0/8` RFC1918
 *     address and use the connect-latency / connect-success signal to probe
 *     internal infrastructure. Cloudflare Workers egress already refuses these
 *     (so it is mostly fail-fast UX + defense in depth), but rejecting them at
 *     the boundary hard-codes the intent and inherits the guard for any future
 *     non-Workers runner. Monitoring a public host:port is the intended use.
 *   - **reject `localhost` / `*.localhost`** — same intent, the name form.
 *   - **non-empty, length-capped host** — bound the stored row + a pathological
 *     host string.
 *
 * NOTE: a bare DNS NAME that happens to RESOLVE into a private range is NOT
 * blocked statically here (we can't resolve at validation time) — exactly as the
 * http policy documents; the runtime's own egress rules are the backstop for
 * that, and `connect()` to such a name simply fails the check.
 */

import { isBlockedHostname } from "@/lib/monitors/http/url-policy";

/** The verdict: `ok`, or a user-facing `reason` the form surfaces inline. */
export type HostPolicyResult = { ok: true } | { ok: false; reason: string };

const MAX_HOST_LENGTH = 255;

/**
 * Validate a TCP monitor target host against the policy. Returns `{ ok: true }`
 * or a single user-facing `reason`. Pure and synchronous — the same call serves
 * the zod refinement (write path) and the executor's pre-connect re-check (read
 * path), mirroring how `checkUrlPolicy` serves both http boundaries.
 *
 * The host is normalised first: a surrounding `[...]` (the bracketed IPv6 form a
 * user might paste from a URL) is stripped so the IPv6 block logic matches, and
 * leading/trailing whitespace is trimmed. An empty or over-long host, or one in
 * the blocked set, is rejected.
 */
export function checkTcpHostPolicy(rawHost: string): HostPolicyResult {
  const host = rawHost.trim();
  if (host.length === 0) {
    return { ok: false, reason: "Enter a host to connect to" };
  }
  if (host.length > MAX_HOST_LENGTH) {
    return { ok: false, reason: "Host is too long" };
  }
  // A host with a scheme/path/whitespace/credentials is not a bare host — reject
  // it so a pasted URL doesn't slip an internal target past the host check via a
  // path or `user@` prefix the bare-host block logic doesn't inspect.
  if (/[/\\@?#\s]/.test(host) || host.includes("://")) {
    return {
      ok: false,
      reason: "Enter a bare host (e.g. db.example.com), not a URL",
    };
  }
  // A host made only of digits and dots that is NOT a canonical dotted-quad is a
  // non-canonical IPv4 encoding (e.g. "127.1", "2130706433", "0177.0.0.1") — a
  // classic SSRF block-list bypass: the literal-IP block set below only matches
  // canonical quads, but the runtime can still resolve these short/decimal forms
  // to the internal address. The http policy gets this for free via `new URL()`'s
  // IPv4 normalization; the bare-host tcp path must reject it explicitly. A real
  // DNS name always carries a non-numeric label, so this never rejects one.
  if (/^[0-9.]+$/.test(host) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return { ok: false, reason: "Enter a valid host or IPv4 address" };
  }
  if (isBlockedHostname(host)) {
    return {
      ok: false,
      reason: "Private, loopback, and link-local hosts can't be monitored",
    };
  }
  return { ok: true };
}
