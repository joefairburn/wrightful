import { defineMiddleware } from "void";
import type { Context } from "hono";

/**
 * Security headers that must be present regardless of deployment topology.
 *
 * Void-managed deployments also apply the matching `routing.headers` rules in
 * void.json at the dispatch worker. Own-account deployments and `vp preview`
 * do not pass through that worker, so relying on the edge rule alone leaves SSR
 * and API responses unstamped. Keeping the policy in the app makes both paths
 * equivalent; the edge rules remain a redundant outer layer.
 *
 * This file sorts after `00.cache.ts` and before `00.errors.ts`. It therefore
 * sees the final rewritten error response while the cache middleware remains
 * outermost and can add its default policy last.
 */
const GLOBAL_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

const TRACE_VIEWER_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Service-Worker-Allowed": "/trace-viewer/",
  "Content-Security-Policy":
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
};

export default defineMiddleware(async (c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof Response) {
      replaceResponse(c, withDefensiveHeaders(err, c.req.path));
      return;
    }
    throw err;
  }

  if (!c.res) return;
  const secured = withDefensiveHeaders(c.res, c.req.path);
  if (secured !== c.res) replaceResponse(c, secured);
});

function withDefensiveHeaders(response: Response, path: string): Response {
  // WebSocket upgrades have immutable headers and are not document responses.
  if (response.status === 101) return response;

  const policy = path.startsWith("/trace-viewer/")
    ? { ...GLOBAL_HEADERS, ...TRACE_VIEWER_HEADERS }
    : GLOBAL_HEADERS;

  try {
    for (const [name, value] of Object.entries(policy)) {
      response.headers.set(name, value);
    }
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(policy)) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function replaceResponse(c: Context, response: Response): void {
  c.res = undefined;
  c.res = response;
}
