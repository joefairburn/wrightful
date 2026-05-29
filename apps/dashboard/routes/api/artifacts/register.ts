import { defineHandler } from "void";
import { and, db, eq, inArray } from "void/db";
import { ulid } from "ulid";
import { env } from "void/env";
import { artifacts, runs, testResults } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { RegisterArtifactsPayloadSchema } from "@/lib/schemas";
import { chunkByParams } from "@/lib/ingest";

const ARTIFACT_COLUMNS = 12;
const MAX_IN_ARRAY_IDS = 99;

/**
 * POST /api/artifacts/register
 *
 * Reserves a row per artifact + returns presigned upload URLs. Rows go in
 * eagerly — existence == promise to upload. A failed PUT leaves an orphan
 * row whose download endpoint will 404; acceptable for v1.
 */
export const POST = defineHandler.withValidator({
  body: RegisterArtifactsPayloadSchema,
})(async (c, { body: payload }) => {
  const maxBytes = env.WRIGHTFUL_MAX_ARTIFACT_BYTES;
  const oversized = payload.artifacts.find((a) => a.sizeBytes > maxBytes);
  if (oversized) {
    return c.json(
      {
        error: `Artifact "${oversized.name}" exceeds the ${maxBytes}-byte limit`,
        maxBytes,
      },
      413,
    );
  }

  const scope = await tenantScopeForApiKey(getApiKey(c));

  const ownerRun = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, payload.runId)))
    .limit(1);
  if (!ownerRun[0]) return c.json({ error: "Run not found" }, 404);

  // Validate every testResultId belongs to this run + project. Chunk so
  // a single parameter list stays under D1's limit.
  const requestedIds = Array.from(
    new Set(payload.artifacts.map((a) => a.testResultId)),
  );
  const validIds = new Set<string>();
  for (let i = 0; i < requestedIds.length; i += MAX_IN_ARRAY_IDS) {
    const chunk = requestedIds.slice(i, i + MAX_IN_ARRAY_IDS);
    const rows = await db
      .select({ id: testResults.id })
      .from(testResults)
      .where(
        and(
          eq(testResults.projectId, scope.projectId),
          eq(testResults.runId, payload.runId),
          inArray(testResults.id, chunk),
        ),
      );
    for (const r of rows) validIds.add(r.id);
  }
  const unknown = requestedIds.filter((id) => !validIds.has(id));
  if (unknown.length > 0) {
    return c.json(
      {
        error: "One or more testResultId values do not belong to this run",
        unknownTestResultIds: unknown,
      },
      400,
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows: Array<typeof artifacts.$inferInsert> = [];
  const uploads: Array<{
    artifactId: string;
    uploadUrl: string;
    r2Key: string;
  }> = [];

  for (const a of payload.artifacts) {
    const artifactId = ulid();
    const r2Key = `t/${scope.teamId}/p/${scope.projectId}/runs/${payload.runId}/${a.testResultId}/${artifactId}/${a.name}`;
    rows.push({
      id: artifactId,
      projectId: scope.projectId,
      testResultId: a.testResultId,
      type: a.type,
      name: a.name,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      r2Key,
      attempt: a.attempt,
      createdAt: nowSeconds,
      role: a.role ?? null,
      snapshotName: a.snapshotName ?? null,
    });
    uploads.push({
      artifactId,
      uploadUrl: `/api/artifacts/${artifactId}/upload`,
      r2Key,
    });
  }

  const statements = chunkByParams(rows, ARTIFACT_COLUMNS).map((chunk) =>
    db.insert(artifacts).values(chunk),
  );
  if (statements.length === 1) {
    await statements[0];
  } else if (statements.length > 1) {
    await db.batch(statements as never);
  }

  return c.json({ uploads }, 201);
});
