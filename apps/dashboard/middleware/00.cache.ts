import { defineMiddleware } from "void";

/**
 * Default-deny Cache-Control stamp — the safety net for Cloudflare Workers
 * Cache (`cache: { enabled: true }` in wrangler.template.jsonc).
 *
 * Workers Cache follows RFC 9111 *including heuristic freshness*: a response
 * with NO Cache-Control header and a heuristically-cacheable status (200, 404,
 * …) may be stored in the shared edge cache and served to other visitors. A
 * session cookie on the request does NOT bypass the cache (only a response
 * `Set-Cookie` / request `Authorization` header does) and the cache key does
 * not include cookies — so an unstamped, cookie-authed tenant page would be a
 * cross-tenant leak once the shared cache is on. Stamping `private, no-store`
 * on every response that didn't set an explicit policy makes edge caching
 * opt-in: /assets/* chunks (Void's asset entry + void.json routing.headers)
 * and artifact downloads (`src/lib/artifacts.ts`) declare `public, …`
 * themselves.
 *
 * Must sort BEFORE `00.errors.ts` (outermost) so the stamp lands on the FINAL
 * response — including the /oops and /not-found rewrites (404 is a
 * heuristically-cacheable status). Deliberately no try/catch around `next()`:
 * exceptions 00.errors re-throws (API-path errors, pass-through Responses)
 * propagate unchanged.
 */
export default defineMiddleware(async (c, next) => {
  await next();
  const res = c.res;
  // WebSocket upgrades (`/ws/*` rooms) carry immutable headers and are never
  // cacheable; leave them untouched.
  if (!res || res.status === 101) return;
  if (res.headers.has("cache-control")) return;
  try {
    res.headers.set("cache-control", "private, no-store");
  } catch {
    // A response passed through from `fetch()` has immutable headers — rebuild
    // it with a mutable copy. `c.res = undefined` first so Hono's setter
    // doesn't merge the old headers into the replacement (see 00.errors.ts's
    // replaceResponse).
    const headers = new Headers(res.headers);
    headers.set("cache-control", "private, no-store");
    c.res = undefined;
    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
});
