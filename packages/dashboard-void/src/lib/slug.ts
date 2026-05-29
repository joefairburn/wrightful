export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const SLUG_ERROR =
  "Slug must be 1–40 lowercase alphanumerics and hyphens, starting and ending with a letter or number.";

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}
