/**
 * Parse a positive integer from an env var string, falling back to a default
 * when the value is empty, non-numeric, or <= 0. Used for TTLs and size caps.
 */
export function readIntVar(raw: string, fallback: number): number {
  if (raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
