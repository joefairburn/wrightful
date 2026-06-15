// Locate and read the repo's CODEOWNERS file at onBegin so the dashboard can
// derive test ownership (roadmap 2.3). The reporter runs in Node, so `fs` is
// available. Best-effort: a missing/unreadable/oversized file yields `null` and
// the field is simply omitted from the open-run payload — it must never break a
// run.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Candidate CODEOWNERS locations, in GitHub's resolution order — the FIRST one
 * found wins. (GitHub itself checks `.github/`, the repo root, then `docs/`.)
 */
export const CODEOWNERS_CANDIDATES = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

/**
 * Skip a CODEOWNERS file larger than this (bytes). A pathological file must not
 * bloat the open-run request; matches the dashboard's `MAX.CODEOWNERS` cap.
 */
export const MAX_CODEOWNERS_BYTES = 64 * 1024;

/**
 * Read the repo's CODEOWNERS file, resolving candidate paths relative to
 * `rootDir` (Playwright's `config.rootDir`; falls back to `process.cwd()`).
 * Returns the file contents, or `null` when no candidate exists, the file is
 * unreadable, or it exceeds {@link MAX_CODEOWNERS_BYTES}. Never throws.
 */
export async function readCodeowners(
  rootDir: string | null,
): Promise<string | null> {
  const base = rootDir ?? process.cwd();
  for (const candidate of CODEOWNERS_CANDIDATES) {
    try {
      const contents = await readFile(join(base, candidate), "utf8");
      // Byte length, not char length — multibyte content could exceed the cap
      // while staying under it in chars. Over the cap → skip (don't truncate a
      // partial rule line into a misleading match).
      if (Buffer.byteLength(contents, "utf8") > MAX_CODEOWNERS_BYTES) {
        return null;
      }
      return contents;
    } catch {
      // Missing / unreadable candidate — try the next one.
    }
  }
  return null;
}
