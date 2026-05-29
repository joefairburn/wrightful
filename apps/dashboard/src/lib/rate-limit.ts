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

/**
 * Check a single request against a Cloudflare rate limiter binding. Returns
 * `true` (allowed) when the binding is unavailable (local dev / miniflare
 * doesn't always wire rate limiters) or when the limiter reports success.
 * Returns `false` only when the limiter is present AND reports the key over
 * its budget. `key === null` means "skip this limiter for this request".
 *
 * Shared by the `rateLimit()` per-route factory and the global
 * `middleware/03.rate-limit.ts` path-matched gate so both honor identical
 * fail-open-in-dev semantics.
 */
export async function checkRateLimit(
  env: unknown,
  bindingName: RateLimiterBindingName,
  key: string | null,
): Promise<boolean> {
  if (key === null) return true;
  const limiter = (env as RateLimiterEnv)[bindingName];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

export function rateLimit(
  bindingName: RateLimiterBindingName,
  keyFn: (c: Parameters<MiddlewareHandler>[0]) => string | null,
): MiddlewareHandler {
  return defineMiddleware(async (c, next) => {
    const allowed = await checkRateLimit(c.env, bindingName, keyFn(c));
    if (!allowed) {
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
