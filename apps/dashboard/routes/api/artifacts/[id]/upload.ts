import { defineHandler } from "void";
import { and, db, eq } from "void/db";
import { storage } from "void/storage";
import { artifacts } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { safeContentType } from "@/lib/content-types";
import { tenantScopeForApiKey } from "@/lib/scope";

/**
 * PUT /api/artifacts/:id/upload
 *
 * Streams the request body into R2 via `void/storage`. Re-verifies that the
 * artifact row belongs to the API-key's project — defense in depth against
 * a leaked id being PUT against from a foreign caller.
 */
export const PUT = defineHandler(async (c) => {
  const apiKey = getApiKey(c);
  const artifactId = c.req.param("id");
  if (!artifactId) return c.json({ error: "Not found" }, 404);

  const scope = await tenantScopeForApiKey(apiKey);

  const rows = await db
    .select({
      r2Key: artifacts.r2Key,
      contentType: artifacts.contentType,
      sizeBytes: artifacts.sizeBytes,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, scope.projectId),
        eq(artifacts.id, artifactId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "Not found" }, 404);

  const header = c.req.header("content-length");
  if (!header) {
    return c.json({ error: "Content-Length required" }, 400);
  }
  const contentLength = Number(header);
  if (!Number.isFinite(contentLength) || contentLength !== row.sizeBytes) {
    return c.json(
      {
        error: "Content-Length does not match registered sizeBytes",
        expected: row.sizeBytes,
        received: contentLength,
      },
      400,
    );
  }

  const body = c.req.raw.body;
  if (!body) {
    return c.json({ error: "Request body required" }, 400);
  }

  try {
    await storage.put(row.r2Key, body, {
      httpMetadata: { contentType: safeContentType(row.contentType) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "R2 write failed";
    return c.json({ error: message }, 502);
  }

  return new Response(null, { status: 204 });
});
