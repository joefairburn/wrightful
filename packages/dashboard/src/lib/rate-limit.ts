import type { RouteMiddleware } from "rwsdk/router";

/**
 * Thin middleware factory around Cloudflare's native `ratelimit` binding.
 * State is held by Cloudflare at the edge (distributed across isolates and
 * pops), so this is an edge-grade rate limit, not the defense-in-depth we
 * used to ship with the in-memory bucket.
 *
 * Key choice matters more than the binding config: Cloudflare specifically
 * recommends against raw IP keys (NATs, corporate egress, shared IPv4) and
 * suggests stable identifiers — API key ids, user ids, tenant ids. Each
 * caller of `rateLimit()` passes a `key(request, ctx)` fn so the key can be
 * picked per-route (IP+path for unauthenticated auth routes, apiKey.id for
 * bearer-token routes, etc).
 */

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

type KeyFn = (request: Request, ctx: Record<string, unknown>) => string | null;

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

export function rateLimit(
  binding: RateLimitBinding,
  key: KeyFn,
): RouteMiddleware {
  return async ({ request, ctx }) => {
    // Local dev is a single developer; the limit adds nothing here and trips
    // legitimate workflows like `pnpm seed:history` that fire thousands of
    // ingest requests in seconds.
    if (import.meta.env.VITE_IS_DEV_SERVER) return;
    const resolved = key(request, ctx as unknown as Record<string, unknown>);
    if (resolved === null) return; // key fn opted out — don't rate-limit this request
    const { success } = await binding.limit({ key: resolved });
    if (!success) {
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          // Native binding doesn't expose a deterministic reset timestamp, so
          // hint at a conservative retry window.
          "Retry-After": "60",
        },
      });
    }
  };
}
