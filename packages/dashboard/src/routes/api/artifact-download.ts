import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { artifacts } from "@/db/schema";
import { verifyArtifactToken } from "@/lib/artifact-tokens";

const ALLOWED_CROSS_ORIGINS = new Set(["https://trace.playwright.dev"]);

/**
 * GET /api/artifacts/:id/download?t=<token>
 *
 * Authentication: a short-lived HMAC token signed by BETTER_AUTH_SECRET.
 * Tokens are minted server-side on authenticated dashboard pages and embedded
 * in the download href. This replaces the earlier "ULID-in-URL is enough"
 * posture so a leaked ULID (referrer, browser history, share link) doesn't
 * grant permanent global read.
 *
 * CORS: narrowed from `*` to the dashboard origin + the Playwright trace
 * viewer (`https://trace.playwright.dev`), since the viewer fetches the .zip
 * cross-origin.
 */
export async function artifactDownloadHandler({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string>;
}) {
  const artifactId = params.id;
  if (!artifactId) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  if (!token || !(await verifyArtifactToken(artifactId, token))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const corsOrigin = resolveAllowedOrigin(request, url.origin);

  const db = getDb();
  const rows = await db
    .select({ r2Key: artifacts.r2Key })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  if (rows.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const key = rows[0].r2Key;

  if (request.method === "HEAD") {
    const head = await env.R2.head(key);
    if (!head) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(null, {
      status: 200,
      headers: buildHeaders(head, corsOrigin),
    });
  }

  const object = await env.R2.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = buildHeaders(object, corsOrigin);
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

function buildHeaders(object: R2Object, allowedOrigin: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  // Artifacts are immutable (ULID-keyed). Let the Cloudflare edge cache
  // absorb repeat reads — the trace viewer reloads chunks of the zip on
  // every navigation.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  // CORS is now restricted to the dashboard origin + known cross-origin
  // consumers (currently just the Playwright trace viewer). `Vary: Origin`
  // keeps the CF edge cache from mixing headers across callers.
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
