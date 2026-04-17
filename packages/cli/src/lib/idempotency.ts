import { randomUUID } from "node:crypto";

export function generateIdempotencyKey(
  ciBuildId: string | null | undefined,
): string {
  if (ciBuildId) {
    return ciBuildId;
  }
  return randomUUID();
}
