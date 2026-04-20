import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { artifacts, committedRuns, testResults } from "@/db/schema";
import {
  RegisterArtifactsPayloadSchema,
  type RegisterArtifactsPayload,
} from "./schemas";
import { readIntVar } from "@/lib/env-parse";
import type { AppContext } from "@/worker";

const DEFAULT_MAX_ARTIFACT_BYTES = 52_428_800; // 50 MiB

// D1 caps a single statement at 100 bound parameters. The artifacts insert
// writes 9 columns per row, so batches >11 rows overflow the cap — which the
// reporter hits on a 3-attempt × 4-attachment failed test (12 rows).
const MAX_PARAMS_PER_STATEMENT = 99;
const ARTIFACT_COLUMNS = 9;
const ARTIFACT_ROWS_PER_STATEMENT = Math.floor(
  MAX_PARAMS_PER_STATEMENT / ARTIFACT_COLUMNS,
);
// Single-column `inArray(...)` against the same 99-param budget.
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
  const projectId = ctx.apiKey?.projectId;
  if (!projectId) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

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

  const db = getDb();

  // Validate the run belongs to this API key's project before touching any
  // testResultId. Without this check a caller could register uploads against
  // another tenant's run by guessing its ULID.
  const [ownerRun] = await db
    .select({ id: committedRuns.id })
    .from(committedRuns)
    .where(
      and(
        eq(committedRuns.id, payload.runId),
        eq(committedRuns.projectId, projectId),
      ),
    )
    .limit(1);
  if (!ownerRun) {
    return jsonResponse({ error: "Run not found" }, 404);
  }

  // Validate every testResultId belongs to the supplied runId. Each id is
  // one bound param in the inArray; chunk so we stay under D1's 100-param
  // cap even if a client sends a huge batch.
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
          eq(testResults.runId, payload.runId),
          inArray(testResults.id, chunk),
        ),
      );
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

  const now = new Date();

  const rows: (typeof artifacts.$inferInsert)[] = [];
  const uploads: Array<{
    artifactId: string;
    uploadUrl: string;
    r2Key: string;
  }> = [];

  for (const a of payload.artifacts) {
    const artifactId = ulid();
    const r2Key = `runs/${payload.runId}/${a.testResultId}/${artifactId}/${a.name}`;
    rows.push({
      id: artifactId,
      testResultId: a.testResultId,
      type: a.type,
      name: a.name,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      r2Key,
      attempt: a.attempt,
      createdAt: now,
    });
    uploads.push({
      artifactId,
      uploadUrl: `/api/artifacts/${artifactId}/upload`,
      r2Key,
    });
  }

  // Eager insert — row existence == artifact was promised. A failed PUT leaves
  // an orphan row whose download endpoint will 404; that's acceptable for v1.
  for (let i = 0; i < rows.length; i += ARTIFACT_ROWS_PER_STATEMENT) {
    await db
      .insert(artifacts)
      .values(rows.slice(i, i + ARTIFACT_ROWS_PER_STATEMENT));
  }

  return jsonResponse({ uploads }, 201);
}
