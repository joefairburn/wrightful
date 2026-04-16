import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { artifacts, testResults } from "@/db/schema";
import { PresignPayloadSchema, type PresignPayload } from "./schemas";
import { presignPut, readR2Config } from "@/lib/r2-presign";

const DEFAULT_MAX_ARTIFACT_BYTES = 52_428_800; // 50 MiB
const DEFAULT_PUT_TTL_SECONDS = 900;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readIntEnv(
  envRecord: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = envRecord[key];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function presignHandler({ request }: { request: Request }) {
  let payload: PresignPayload;
  try {
    const body = await request.json();
    payload = PresignPayloadSchema.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const envRecord = env as unknown as Record<string, unknown>;
  const maxBytes = readIntEnv(
    envRecord,
    "GREENROOM_MAX_ARTIFACT_BYTES",
    DEFAULT_MAX_ARTIFACT_BYTES,
  );
  const ttl = readIntEnv(
    envRecord,
    "GREENROOM_PRESIGN_PUT_TTL_SECONDS",
    DEFAULT_PUT_TTL_SECONDS,
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

  let r2Config;
  try {
    r2Config = readR2Config(envRecord);
  } catch (err) {
    const message = err instanceof Error ? err.message : "R2 not configured";
    return jsonResponse({ error: message }, 500);
  }

  const db = getDb();

  // Validate every testResultId belongs to the supplied runId
  const requestedIds = Array.from(
    new Set(payload.artifacts.map((a) => a.testResultId)),
  );
  const valid = await db
    .select({ id: testResults.id })
    .from(testResults)
    .where(
      and(
        eq(testResults.runId, payload.runId),
        inArray(testResults.id, requestedIds),
      ),
    );
  const validIds = new Set(valid.map((r) => r.id));
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
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

  const rows: (typeof artifacts.$inferInsert)[] = [];
  const uploads: Array<{
    artifactId: string;
    url: string;
    r2Key: string;
    expiresAt: string;
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
      createdAt: now,
    });
    const url = await presignPut(r2Config, r2Key, ttl);
    uploads.push({ artifactId, url, r2Key, expiresAt });
  }

  // Eager insert — row existence == artifact was promised. A failed PUT leaves
  // an orphan row whose download endpoint will 404; that's acceptable for v1.
  await db.insert(artifacts).values(rows);

  return jsonResponse({ uploads }, 201);
}
