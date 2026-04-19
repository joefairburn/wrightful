import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { artifacts, committedRuns, testResults } from "@/db/schema";
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
 * Streams the request body into R2 via the native binding. The artifact row
 * was inserted by /api/artifacts/register; we verify the caller's API key
 * owns the project that owns the run that owns the testResult before
 * accepting the write.
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
  const projectId = ctx.apiKey?.projectId;
  if (!projectId) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const artifactId = params.id;
  if (!artifactId) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const db = getDb();
  const [row] = await db
    .select({
      r2Key: artifacts.r2Key,
      contentType: artifacts.contentType,
      sizeBytes: artifacts.sizeBytes,
    })
    .from(artifacts)
    .innerJoin(testResults, eq(testResults.id, artifacts.testResultId))
    .innerJoin(committedRuns, eq(committedRuns.id, testResults.runId))
    .where(
      and(eq(artifacts.id, artifactId), eq(committedRuns.projectId, projectId)),
    )
    .limit(1);

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
