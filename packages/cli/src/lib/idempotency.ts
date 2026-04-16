import { randomUUID } from "node:crypto";

export function generateIdempotencyKey(
  ciBuildId: string | null | undefined,
  shardIndex: number | null | undefined,
): string {
  if (ciBuildId) {
    const shard = shardIndex ?? 0;
    return `${ciBuildId}-${shard}`;
  }
  return randomUUID();
}
