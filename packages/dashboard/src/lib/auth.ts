import type { Selectable } from "kysely";
import { getControlDb, type ControlDatabase } from "@/control";

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

export type ApiKey = Selectable<ControlDatabase["apiKeys"]>;

export async function validateApiKey(
  authHeader: string | null,
): Promise<ApiKey | null> {
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const rawKey = match[1];
  const prefix = rawKey.slice(0, 8);
  const hash = await hashKey(rawKey);

  const db = getControlDb();
  const candidates = await db
    .selectFrom("apiKeys")
    .selectAll()
    .where("keyPrefix", "=", prefix)
    .execute();

  const key = candidates.find((k) => timingSafeEqualHex(k.keyHash, hash));
  if (!key) return null;
  if (key.revokedAt) return null;

  // Update lastUsedAt (fire and forget — the metadata isn't load-bearing and
  // we don't want auth-path latency to depend on a second write).
  db.updateTable("apiKeys")
    .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
    .where("id", "=", key.id)
    .execute()
    .catch(() => {});

  return key;
}
