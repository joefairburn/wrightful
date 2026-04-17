import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { artifacts } from "@/db/schema";

/**
 * GET /api/artifacts/:id/download
 *
 * Authentication: the artifact id is an unguessable ulid that's only surfaced
 * on authenticated dashboard pages. v1 posture — revisit for a signed-token
 * challenge in Phase 5. Keeping this endpoint unauthenticated lets external
 * viewers (in particular trace.playwright.dev) follow the link without any
 * Authorization header.
 *
 * TODO(phase5): replace ulid-in-URL with signed-token challenge.
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
    return new Response(null, { status: 200, headers: buildHeaders(head) });
  }

  const object = await env.R2.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = buildHeaders(object);
  const hasBody = "body" in object && object.body !== null;
  const hasRange = request.headers.get("range") !== null;

  if ("range" in object && object.range) {
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
    status: hasRange ? 206 : 200,
    headers,
  });
}

function buildHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  // Artifacts are immutable (ULID-keyed). Let the Cloudflare edge cache
  // absorb repeat reads — the trace viewer reloads chunks of the zip on
  // every navigation.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  // trace.playwright.dev fetches cross-origin; the previous presigned-URL
  // flow worked because R2's S3 endpoint sets ACAO:* by default.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "Range, If-Match, If-None-Match");
  headers.set(
    "access-control-expose-headers",
    "Content-Length, Content-Range, ETag",
  );
  return headers;
}
