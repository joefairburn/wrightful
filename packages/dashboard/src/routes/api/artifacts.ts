import { env } from "cloudflare:workers";
import { ulid } from "ulid";
import { tenantScopeForApiKey } from "@/tenant";
import {
  RegisterArtifactsPayloadSchema,
  type RegisterArtifactsPayload,
} from "./schemas";
import { readIntVar } from "@/lib/env-parse";
import type { AppContext } from "@/worker";

const DEFAULT_MAX_ARTIFACT_BYTES = 52_428_800; // 50 MiB

// Bound statement size so a single huge reporter batch doesn't blow up
// memory in the RPC round-trip. 9 columns × 11 rows = 99 params.
const MAX_PARAMS_PER_STATEMENT = 99;
const ARTIFACT_COLUMNS = 9;
const ARTIFACT_ROWS_PER_STATEMENT = Math.floor(
  MAX_PARAMS_PER_STATEMENT / ARTIFACT_COLUMNS,
);
const MAX_IN_ARRAY_IDS = MAX_PARAMS_PER_STATEMENT;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function registerHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  if (!ctx.apiKey) return jsonResponse({ error: "Unauthorized" }, 401);

  let payload: RegisterArtifactsPayload;
  try {
    const body = await request.json();
    payload = RegisterArtifactsPayloadSchema.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const maxBytes = readIntVar(
    env.WRIGHTFUL_MAX_ARTIFACT_BYTES,
    DEFAULT_MAX_ARTIFACT_BYTES,
  );

  const oversized = payload.artifacts.find((a) => a.sizeBytes > maxBytes);
  if (oversized) {
    return jsonResponse(
      {
        error: `Artifact "${oversized.name}" exceeds the ${maxBytes}-byte limit`,
        maxBytes,
      },
      413,
    );
  }

  const scope = await tenantScopeForApiKey(ctx.apiKey);
  if (!scope) return jsonResponse({ error: "Unauthorized" }, 401);

  // Validate the run belongs to this API key's project before touching any
  // testResultId. Without this check a caller could register uploads
  // against another tenant's run by guessing its ULID (within-team
  // cross-project). `committed = 1` keeps in-flight-at-open rows
  // invisible.
  const ownerRun = await scope.db
    .selectFrom("runs")
    .select("id")
    .where("id", "=", payload.runId)
    .where("projectId", "=", scope.projectId)
    .where("committed", "=", 1)
    .limit(1)
    .executeTakeFirst();
  if (!ownerRun) {
    return jsonResponse({ error: "Run not found" }, 404);
  }

  // Validate every testResultId belongs to the supplied runId. Chunk so
  // we don't overgrow a single statement's parameter list.
  const requestedIds = Array.from(
    new Set(payload.artifacts.map((a) => a.testResultId)),
  );
  const validIds = new Set<string>();
  for (let i = 0; i < requestedIds.length; i += MAX_IN_ARRAY_IDS) {
    const chunk = requestedIds.slice(i, i + MAX_IN_ARRAY_IDS);
    const rows = await scope.db
      .selectFrom("testResults")
      .select("id")
      .where("runId", "=", payload.runId)
      .where("id", "in", chunk)
      .execute();
    for (const r of rows) validIds.add(r.id);
  }
  const unknown = requestedIds.filter((id) => !validIds.has(id));
  if (unknown.length > 0) {
    return jsonResponse(
      {
        error: "One or more testResultId values do not belong to this run",
        unknownTestResultIds: unknown,
      },
      400,
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  const rows: Array<{
    id: string;
    testResultId: string;
    type: string;
    name: string;
    contentType: string;
    sizeBytes: number;
    r2Key: string;
    attempt: number;
    createdAt: number;
  }> = [];
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
      testResultId: a.testResultId,
      type: a.type,
      name: a.name,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      r2Key,
      attempt: a.attempt,
      createdAt: nowSeconds,
    });
    uploads.push({
      artifactId,
      uploadUrl: `/api/artifacts/${artifactId}/upload`,
      r2Key,
    });
  }

  // Eager insert — row existence == artifact was promised. A failed PUT
  // leaves an orphan row whose download endpoint will 404; that's
  // acceptable for v1.
  for (let i = 0; i < rows.length; i += ARTIFACT_ROWS_PER_STATEMENT) {
    await scope.db
      .insertInto("artifacts")
      .values(rows.slice(i, i + ARTIFACT_ROWS_PER_STATEMENT))
      .execute();
  }

  return jsonResponse({ uploads }, 201);
}
