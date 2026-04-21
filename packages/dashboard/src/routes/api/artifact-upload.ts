import { env } from "cloudflare:workers";
import { tenantScopeForApiKey } from "@/tenant";
import type { AppContext } from "@/worker";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * PUT /api/artifacts/:id/upload
 *
 * Streams the request body into R2 via the native binding. The artifact
 * row was inserted by /api/artifacts/register into the team's tenant DO;
 * we re-verify ownership there before accepting the write.
 */
export async function artifactUploadHandler({
  request,
  params,
  ctx,
}: {
  request: Request;
  params: Record<string, string>;
  ctx: AppContext;
}) {
  if (!ctx.apiKey) return jsonResponse({ error: "Unauthorized" }, 401);

  const artifactId = params.id;
  if (!artifactId) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const scope = await tenantScopeForApiKey(ctx.apiKey);
  if (!scope) return jsonResponse({ error: "Not found" }, 404);

  const row = await scope.db
    .selectFrom("artifacts")
    .innerJoin("testResults", "testResults.id", "artifacts.testResultId")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .select([
      "artifacts.r2Key as r2Key",
      "artifacts.contentType as contentType",
      "artifacts.sizeBytes as sizeBytes",
    ])
    .where("artifacts.id", "=", artifactId)
    .where("runs.projectId", "=", scope.projectId)
    .where("runs.committed", "=", 1)
    .limit(1)
    .executeTakeFirst();

  if (!row) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const header = request.headers.get("content-length");
  if (!header) {
    return jsonResponse({ error: "Content-Length required" }, 400);
  }
  const contentLength = Number(header);
  if (!Number.isFinite(contentLength) || contentLength !== row.sizeBytes) {
    return jsonResponse(
      {
        error: "Content-Length does not match registered sizeBytes",
        expected: row.sizeBytes,
        received: contentLength,
      },
      400,
    );
  }

  if (!request.body) {
    return jsonResponse({ error: "Request body required" }, 400);
  }

  try {
    await env.R2.put(row.r2Key, request.body, {
      httpMetadata: { contentType: row.contentType },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "R2 write failed";
    return jsonResponse({ error: message }, 502);
  }

  return new Response(null, { status: 204 });
}
