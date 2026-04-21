import { env } from "cloudflare:workers";
import { verifyArtifactToken } from "@/lib/artifact-tokens";

const ALLOWED_CROSS_ORIGINS = new Set(["https://trace.playwright.dev"]);

/**
 * GET /api/artifacts/:id/download?t=<token>
 *
 * Authentication: a short-lived HMAC token signed by BETTER_AUTH_SECRET. The
 * token carries the R2 key + content type directly, so this handler doesn't
 * need to touch the tenant DO at all — verify the signature, stream from R2,
 * done. The `:id` path parameter is vestigial (it makes URLs easier to read
 * in logs) and is ignored.
 *
 * CORS: narrowed from `*` to the dashboard origin + the Playwright trace
 * viewer (`https://trace.playwright.dev`), since the viewer fetches the .zip
 * cross-origin.
 */
export async function artifactDownloadHandler({
  request,
}: {
  request: Request;
  params: Record<string, string>;
}) {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  const payload = token ? await verifyArtifactToken(token) : null;
  if (!payload) {
    return new Response("Unauthorized", { status: 401 });
  }

  const corsOrigin = resolveAllowedOrigin(request, url.origin);
  const { r2Key, contentType } = payload;

  if (request.method === "HEAD") {
    const head = await env.R2.head(r2Key);
    if (!head) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(null, {
      status: 200,
      headers: buildHeaders(head, contentType, corsOrigin),
    });
  }

  const object = await env.R2.get(r2Key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = buildHeaders(object, contentType, corsOrigin);
  const hasBody = "body" in object && object.body !== null;
  // 206 per RFC 7233 requires BOTH a client Range request AND the server
  // serving that partial response. Miniflare populates object.range even
  // without a request Range, and R2 production silently drops unparseable
  // Range values while still returning the full body — gate on both signals.
  const requestedRange = request.headers.get("range") !== null;
  const servedRange =
    requestedRange && "range" in object && Boolean(object.range);

  if (servedRange && object.range) {
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

  // No body returned with onlyIf precondition failure -> 304 Not Modified.
  if (!hasBody) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, {
    status: servedRange ? 206 : 200,
    headers,
  });
}

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
): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Prefer the content-type from the signed token — it reflects what was
  // registered at upload time and survives R2 HEAD calls that occasionally
  // miss the attribute.
  if (!headers.get("content-type")) {
    headers.set("content-type", tokenContentType);
  }
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "public, max-age=31536000, immutable");
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
