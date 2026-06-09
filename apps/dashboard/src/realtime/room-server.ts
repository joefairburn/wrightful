import { timingSafeEqualBytes } from "@/lib/token-crypto";

/** Header carrying the internal shared secret on the server's room-publish POST. */
export const INTERNAL_HEADER = "x-wrightful-internal";

/**
 * Max concurrent connections per room Durable Object. A fan-out ceiling + abuse
 * backstop (the old SSE `defineLiveStream` had `maxSubscriptionsPerTopic: 256`;
 * `void/ws` rooms have no built-in cap, so we enforce it in `onBeforeConnect`).
 * Blast radius of the cap is one run/project room.
 */
export const ROOM_CONNECTION_CAP = 256;

/**
 * Per-build random baked into the SERVER bundle by `vite.config.ts` (`define`).
 * The publisher worker and the room DOs are one Cloudflare deployment / one
 * bundle, so this single value is identical on both sides — it authenticates the
 * DO-to-DO publish POST with zero config and auto-rotates per deploy, decoupled
 * from the session-signing secret. Absent under test/dev-without-build (the
 * `typeof` guard keeps the undeclared-global read safe), where the resolver falls
 * back to `BETTER_AUTH_SECRET`. Read only here (a server-only module), so it
 * never reaches the client bundle.
 */
declare const __WRIGHTFUL_INTERNAL_SECRET__: string | undefined;
const BUILT_IN_SECRET: string | undefined =
  typeof __WRIGHTFUL_INTERNAL_SECRET__ === "string"
    ? __WRIGHTFUL_INTERNAL_SECRET__
    : undefined;

/**
 * Secret authenticating the server's internal room-publish POST. Precedence:
 * an explicit `REALTIME_INTERNAL_SECRET` (operator override / pinning) → the
 * per-build {@link BUILT_IN_SECRET} (the zero-config default). It deliberately
 * does NOT fall back to `BETTER_AUTH_SECRET` — the internal-RPC capability stays
 * fully decoupled from the session-signing secret. `??` is presence, not
 * truthiness, so an empty string is honored.
 *
 * Throws if neither is available, which cannot happen in a real worker: the
 * build always injects `BUILT_IN_SECRET` (dev + prod). The throw is a loud
 * misconfiguration guard — far better than silently authenticating with a wrong
 * or empty secret. It's reached only in test when the explicit env is also
 * omitted; callers in `publish.ts` (try/catch, non-fatal) and the room
 * `onRequest` are resilient to it.
 */
export function resolveInternalSecret(source: {
  REALTIME_INTERNAL_SECRET?: string | undefined;
}): string {
  const secret = source.REALTIME_INTERNAL_SECRET ?? BUILT_IN_SECRET;
  if (secret === undefined) {
    throw new Error(
      "Realtime internal secret unavailable: build-time __WRIGHTFUL_INTERNAL_SECRET__ " +
        "was not injected and REALTIME_INTERNAL_SECRET is unset.",
    );
  }
  return secret;
}

/**
 * Constant-time check that a room-publish request carries the internal secret.
 * Void registers each room's path as a public route, so this is the ONLY gate
 * stopping a forged cross-tenant broadcast from any logged-in user. Compared in
 * constant time via {@link timingSafeEqualBytes} — consistent with the project's
 * other secret compares (api-key, artifact-tokens) — rather than a
 * short-circuiting `!==`.
 */
export function isInternalRequest(request: Request, secret: string): boolean {
  const provided = request.headers.get(INTERNAL_HEADER);
  if (provided === null) return false;
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(provided), encoder.encode(secret));
}

/**
 * True once a room already holds {@link ROOM_CONNECTION_CAP} connections, so
 * `onBeforeConnect` can reject the next upgrade with a 429. Counts lazily and
 * stops at the cap (no full materialization of the connection set).
 */
export function roomAtCapacity(connections: Iterable<unknown>): boolean {
  const iterator = connections[Symbol.iterator]();
  let count = 0;
  while (!iterator.next().done) {
    count += 1;
    if (count >= ROOM_CONNECTION_CAP) return true;
  }
  return false;
}
