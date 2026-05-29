import type { Context } from "hono";
import { db, and, eq } from "void/db";
import { apiKeys, type ApiKey } from "@schema";

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Resolve a Bearer API key to the owning row. Returns null on any failure
 * (no header, malformed, no row, hash mismatch, revoked). Constant-time
 * hash compare across all keys sharing the 8-char prefix.
 *
 * Side-effect: bumps `lastUsedAt` after a successful match. Off the
 * auth-path latency budget via `executionCtx.waitUntil` — workerd keeps the
 * promise alive past the response, but doesn't make the caller wait.
 */
export async function validateApiKey(
  c: Context,
  authHeader: string | null | undefined,
): Promise<ApiKey | null> {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const rawKey = match[1];
  const prefix = rawKey.slice(0, 8);
  const hash = await hashKey(rawKey);

  const candidates = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix));

  const key = candidates.find((k) => timingSafeEqualHex(k.keyHash, hash));
  if (!key) return null;
  if (key.revokedAt) return null;

  c.executionCtx.waitUntil(
    db
      .update(apiKeys)
      .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(apiKeys.id, key.id)))
      .catch(() => {}),
  );

  return key;
}
