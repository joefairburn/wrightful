/**
 * Parse a positive integer from an env var string, falling back to a default
 * when the value is empty, non-numeric, or <= 0. Used for TTLs and size caps.
 */
export function readIntVar(raw: string, fallback: number): number {
  if (raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a boolean-ish env var. Accepts `1`, `true`, `yes`, `on`
 * (case-insensitive) as true; anything else — including empty/undefined — is
 * false. Used for feature gates that should default to "off".
 */
export function parseBooleanEnv(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
