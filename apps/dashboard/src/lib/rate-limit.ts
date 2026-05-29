import type { MiddlewareHandler } from "hono";
import { defineMiddleware } from "void";

/**
 * Cloudflare native rate limiter wrapper. Each limiter is declared in
 * `wrangler.jsonc#ratelimits` (Void doesn't accept `ratelimits` in
 * `void.json#worker` so it lives in the wrangler fallback file). Bindings
 * are injected on the worker `env` at runtime.
 *
 * `keyFn` returns a stable string per requesting tenant. Returning `null`
 * skips the limiter (e.g. an artifact download with no token shouldn't
 * be keyed by IP because that punishes a single user behind a NAT).
 */
interface RateLimiterBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

type RateLimiterBindingName =
  | "AUTH_RATE_LIMITER"
  | "API_RATE_LIMITER"
  | "ARTIFACT_RATE_LIMITER";

type RateLimiterEnv = Partial<
  Record<RateLimiterBindingName, RateLimiterBinding>
>;

export function rateLimit(
  bindingName: RateLimiterBindingName,
  keyFn: (c: Parameters<MiddlewareHandler>[0]) => string | null,
): MiddlewareHandler {
  return defineMiddleware(async (c, next) => {
    const limiter = (c.env as RateLimiterEnv)[bindingName];
    // In local dev miniflare doesn't always wire rate limiter bindings.
    // Skip when unavailable so dev isn't blocked.
    if (!limiter) {
      await next();
      return;
    }
    const key = keyFn(c);
    if (key === null) {
      await next();
      return;
    }
    const { success } = await limiter.limit({ key });
    if (!success) {
      return c.json({ error: "Too many requests" }, 429);
    }
    await next();
  });
}

/**
 * Extract the client IP for keying rate limiters when no stable identity
 * is available (auth / pre-token paths). CF sets `CF-Connecting-IP`; we
 * fall back to `X-Forwarded-For`'s first hop and finally to a literal
 * "unknown" so the limiter still functions (one shared bucket for
 * unidentifiable clients).
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
