import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { artifacts } from "@/db/schema";
import { presignGet, readR2Config } from "@/lib/r2-presign";

const DEFAULT_GET_TTL_SECONDS = 600;

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
  params,
}: {
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

  let cfg;
  try {
    cfg = readR2Config(env as unknown as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : "R2 not configured";
    return new Response(message, { status: 500 });
  }

  const ttl = readIntEnv(
    env as unknown as Record<string, unknown>,
    "GREENROOM_PRESIGN_GET_TTL_SECONDS",
    DEFAULT_GET_TTL_SECONDS,
  );
  const url = await presignGet(cfg, rows[0].r2Key, ttl);
  return Response.redirect(url, 302);
}
