import { defineMiddleware } from "void";
import type { Context } from "hono";
import { isTraceViewerHost } from "@/trace-viewer/origin";

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
// Direct-R2 artifact URLs always use Cloudflare's account-specific S3 host.
// The account ID is deployment-specific, so the CSP uses the narrowest static
// source expression that works for both managed and self-hosted deployments.
export const R2_S3_CSP_ORIGIN = "https://*.r2.cloudflarestorage.com";

export const GLOBAL_CONTENT_SECURITY_POLICY = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com ${R2_S3_CSP_ORIGIN}; font-src 'self' data:; media-src 'self' blob: ${R2_S3_CSP_ORIGIN}; connect-src 'self' ${R2_S3_CSP_ORIGIN}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;

export const TRACE_VIEWER_CONTENT_SECURITY_POLICY = `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; worker-src 'self' blob:; frame-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`;

/** Defense-in-depth CSP for worker-served, same-origin trace snapshots. */
export const TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY = `default-src 'self' data: blob:; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; font-src 'self' data:; media-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; connect-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`;

const GLOBAL_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "Content-Security-Policy": GLOBAL_CONTENT_SECURITY_POLICY,
};

const TRACE_VIEWER_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Service-Worker-Allowed": "/trace-viewer/",
  "Content-Security-Policy": TRACE_VIEWER_CONTENT_SECURITY_POLICY,
};

/**
 * Playwright's own HTML shells inside the vendored bundle. Each frames a DOM
 * snapshot with a HARDCODED `sandbox="allow-same-origin allow-scripts"` that we
 * cannot override — `index.html`'s SPA sets it on its two snapshot iframes,
 * `snapshot.html` on its single one. On the cookieless viewer host that is the
 * point (that is what full-fidelity replay buys). On any other origin — the
 * dashboard included — it would execute attacker-craftable snapshot HTML with
 * the session cookies, which is exactly what `snapshotSandbox` exists to
 * prevent for our own embedded viewer.
 *
 * These are static assets, so they are reachable by typing the URL: gating the
 * links that point at them (MCP's `traceViewerUrl`, the pane's popout) removes
 * the invitation but is not a boundary. This is, because Void routes every
 * request through the Worker (`run_worker_first`) and serves assets from inside
 * the Hono app, so a 404 here wins.
 *
 * Our own viewer needs neither file: it registers the service worker from
 * `bridge.html` and points its iframes at the SW-synthesized
 * `/trace-viewer/snapshot/*`. `uiMode.html` has no `?trace=` entry point at all
 * (it wants a Playwright test-server WebSocket) and is blocked for hygiene.
 */
const SCRIPTED_SNAPSHOT_SHELLS: readonly string[] = [
  "/trace-viewer/index.html",
  "/trace-viewer/snapshot.html",
  "/trace-viewer/uiMode.html",
];

function servesScriptedSnapshotShell(
  path: string,
  pageOrigin: string,
): boolean {
  return (
    SCRIPTED_SNAPSHOT_SHELLS.includes(path) && !isTraceViewerHost(pageOrigin)
  );
}

export default defineMiddleware(async (c, next) => {
  const pageOrigin = new URL(c.req.url).origin;

  // Refuse before `next()`, so the asset layer never even reads the bytes.
  if (servesScriptedSnapshotShell(c.req.path, pageOrigin)) {
    replaceResponse(
      c,
      withDefensiveHeaders(
        new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
        c.req.path,
        pageOrigin,
      ),
    );
    return;
  }

  try {
    await next();
  } catch (err) {
    if (err instanceof Response) {
      replaceResponse(c, withDefensiveHeaders(err, c.req.path, pageOrigin));
      return;
    }
    throw err;
  }

  if (!c.res) return;
  const secured = withDefensiveHeaders(c.res, c.req.path, pageOrigin);
  if (secured !== c.res) replaceResponse(c, secured);
});

function traceViewerPolicy(
  path: string,
  pageOrigin: string,
): Readonly<Record<string, string>> {
  const base = { ...GLOBAL_HEADERS, ...TRACE_VIEWER_HEADERS };
  // The script-less snapshot CSP applies on EVERY origin except the configured
  // cookieless viewer host itself. The same Worker serves both hostnames in
  // separate-origin mode, so `/trace-viewer/snapshot/*` stays reachable on the
  // dashboard origin — where attacker-craftable snapshot HTML must never get
  // `script-src 'self' 'unsafe-inline' …` under the session origin. Only on
  // the viewer host are snapshot scripts safe by design (no cookies, no
  // dashboard DOM), mirroring `snapshotSandbox`'s allow-scripts decision.
  if (
    path.startsWith("/trace-viewer/snapshot/") &&
    !isTraceViewerHost(pageOrigin)
  ) {
    return {
      ...base,
      "Content-Security-Policy": TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY,
    };
  }
  return base;
}

function withDefensiveHeaders(
  response: Response,
  path: string,
  pageOrigin: string,
): Response {
  // WebSocket upgrades have immutable headers and are not document responses.
  if (response.status === 101) return response;

  const policy = path.startsWith("/trace-viewer/")
    ? traceViewerPolicy(path, pageOrigin)
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
