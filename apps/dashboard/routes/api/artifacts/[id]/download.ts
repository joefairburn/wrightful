import { defineHandler } from "void";
import type { Context } from "hono";
import { storage } from "void/storage";
import { verifyArtifactToken } from "@/lib/artifact-tokens";
import { safeContentType } from "@/lib/content-types";

// `R2Object` resolves via the `/// <reference types="@cloudflare/workers-types" />`
// triple-slash reference inside `void/env`'s d.ts — we don't need to import
// the type explicitly, and we don't depend on `@cloudflare/workers-types`
// directly. Leaving it as a free identifier matches the auto-load.

const ALLOWED_CROSS_ORIGINS = new Set(["https://trace.playwright.dev"]);

/**
 * GET/HEAD /api/artifacts/:id/download?t=<token>
 *
 * Token-authenticated artifact stream. The HMAC token (signed with
 * `ARTIFACT_TOKEN_SECRET`, falling back to `BETTER_AUTH_SECRET` when unset —
 * see `lib/artifact-tokens.ts#getKey`) carries the R2 key + content-type
 * directly, so we skip the DB on the hot path. CORS narrowed to the dashboard
 * + the Playwright trace viewer.
 */
async function handle(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  const token = url.searchParams.get("t");
  const payload = token ? await verifyArtifactToken(token) : null;
  if (!payload) {
    return unauthorizedResponse(c);
  }

  const corsOrigin = resolveAllowedOrigin(c.req.raw, url.origin);
  const { r2Key, contentType } = payload;

  if (c.req.method === "HEAD") {
    const head = await storage.head(r2Key);
    if (!head) return new Response("Not found", { status: 404 });
    return new Response(null, {
      status: 200,
      headers: buildHeaders(head, contentType, corsOrigin, r2Key),
    });
  }

  const object = await storage.get(r2Key, {
    range: c.req.raw.headers,
    onlyIf: c.req.raw.headers,
  });
  if (!object) return new Response("Not found", { status: 404 });

  const headers = buildHeaders(object, contentType, corsOrigin, r2Key);
  const hasBody = "body" in object && object.body !== null;
  const requestedRange = c.req.header("range") !== undefined;
  const servedRange =
    requestedRange && "range" in object && Boolean(object.range);

  if (servedRange && "range" in object && object.range) {
    const range = object.range;
    const offset = "offset" in range ? (range.offset ?? 0) : 0;
    const length =
      "length" in range && range.length !== undefined
        ? range.length
        : object.size - offset;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    headers.set("content-length", String(length));
  }

  if (!hasBody) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, {
    status: servedRange ? 206 : 200,
    headers,
  });
}

function unauthorizedResponse(c: Context): Response {
  // Direct browser navigation (right-click → open artifact in new tab) gets a
  // styled HTML page when the token is missing or expired; `<img>`/fetch/trace
  // viewer clients (Accept: image/*, application/json, etc.) keep getting
  // plain text so error handling stays predictable on the wire.
  const accept = c.req.header("Accept") ?? "";
  if (!accept.includes("text/html")) {
    return new Response("Unauthorized", { status: 401 });
  }
  return new Response(EXPIRED_ARTIFACT_HTML, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Self-contained HTML page (no asset pipeline). Stays in sync with the design
// tokens by mirroring the dashboard's neutral surface + accent colors; keeps
// styles inline so a broken artifact link still renders cleanly even if the
// CSS bundle is unavailable.
const EXPIRED_ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Artifact link expired · Wrightful</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { display: flex; align-items: center; justify-content: center; background: #fafafa; color: #0a0a0a; }
    @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #fafafa; } }
    main { max-width: 28rem; padding: 1.5rem; text-align: center; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { font-size: 0.875rem; line-height: 1.5; opacity: 0.7; margin: 0 0 1.5rem; }
    a { display: inline-block; padding: 0.5rem 1rem; border: 1px solid currentColor; border-radius: 0.375rem; color: inherit; text-decoration: none; font-size: 0.8125rem; font-weight: 500; }
    a:hover { opacity: 0.8; }
  </style>
</head>
<body>
  <main>
    <h1>Artifact link expired</h1>
    <p>This artifact link is no longer valid. Open the run in the dashboard to load a fresh link.</p>
    <a href="/">Back to dashboard</a>
  </main>
</body>
</html>`;

function resolveAllowedOrigin(
  request: Request,
  dashboardOrigin: string,
): string {
  const origin = request.headers.get("origin");
  if (!origin) return dashboardOrigin;
  if (origin === dashboardOrigin) return origin;
  if (ALLOWED_CROSS_ORIGINS.has(origin)) return origin;
  return dashboardOrigin;
}

function buildHeaders(
  object: R2Object,
  tokenContentType: string,
  allowedOrigin: string,
  r2Key: string,
): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Always override with a sanitised content-type. R2 objects stored before
  // the registration allowlist landed could still carry an unsafe
  // `httpMetadata.contentType` (e.g. `text/html`) — normalising here makes
  // sure no legacy row can hand the dashboard's origin to an attacker.
  headers.set("content-type", safeContentType(tokenContentType));
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  // Force a download on top-level navigation so a leaked signed URL pasted
  // into the address bar never renders as HTML/JS on the dashboard origin.
  // Subresource loads (<img>, <video>, fetch(), trace.playwright.dev) ignore
  // Content-Disposition and keep working, so the in-app rendering paths are
  // unaffected. RFC 5987 `filename*` syntax handles UTF-8 names safely and
  // `encodeURIComponent` percent-encodes the characters (\r, \n, ") that
  // would otherwise allow header injection via a hostile artifact name.
  const filename = r2Key.split("/").pop() ?? "artifact";
  headers.set(
    "content-disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "Range, If-Match, If-None-Match");
  headers.set(
    "access-control-expose-headers",
    "Content-Length, Content-Range, ETag",
  );
  return headers;
}

// HEAD requests fall through to the GET route in Hono. The handler branches
// on `c.req.method === "HEAD"` to short-circuit with a metadata-only response
// (no R2 GET, just `storage.head()`).
export const GET = defineHandler(handle);
