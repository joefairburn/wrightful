import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function validateApiKey(
  authHeader: string | null,
): Promise<typeof apiKeys.$inferSelect | null> {
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const rawKey = match[1];
  const prefix = rawKey.slice(0, 8);
  const hash = await hashKey(rawKey);

  const db = getDb();
  const candidates = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix));

  const key = candidates.find((k) => k.keyHash === hash);
  if (!key) return null;
  if (key.revokedAt) return null;

  // Update lastUsedAt (fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .run()
    .catch(() => {});

  return key;
}
