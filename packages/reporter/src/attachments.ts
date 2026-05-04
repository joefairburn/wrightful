import { realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";

// Playwright attachment → Wrightful artifact-type mapping, plus path-safety
// helpers used by the reporter before uploading local files to R2.

export type ArtifactType =
  | "trace"
  | "screenshot"
  | "video"
  | "visual"
  | "other";

export type SnapshotRole = "expected" | "actual" | "diff";

export interface SnapshotAttachmentMeta {
  snapshotName: string;
  role: SnapshotRole;
}

/**
 * Detects Playwright snapshot attachments produced by `toHaveScreenshot()`
 * (and image variants of `toMatchSnapshot()`). Playwright names them
 * `{baseName}-(expected|actual|diff).png`. Returns the trimmed `snapshotName`
 * (e.g. `hero-chromium-linux`) and the role; null otherwise.
 *
 * Returning a match here is *not* sufficient to classify the attachment as
 * `visual` — the reporter additionally requires all three roles to be
 * present in the same `(testId, attempt)` set before promoting the type
 * (see `collectArtifacts` in index.ts). A user-named `foo-actual.png` from
 * `testInfo.attach()` falls back to `screenshot` via that gate.
 */
export function parseSnapshotAttachment(
  filename: string,
): SnapshotAttachmentMeta | null {
  const base = basename(filename);
  const match = /^(.+)-(expected|actual|diff)\.png$/.exec(base);
  if (!match) return null;
  return {
    snapshotName: match[1],
    role: match[2] as SnapshotRole,
  };
}

export function classifyAttachment(
  name: string,
  contentType: string,
): ArtifactType {
  const ct = contentType.toLowerCase();
  if (ct === "application/zip" || ct === "application/x-zip-compressed") {
    return "trace";
  }
  if (ct.startsWith("image/")) return "screenshot";
  if (ct.startsWith("video/")) return "video";

  const ext = extname(name).toLowerCase();
  if (ext === ".zip" && name.includes("trace")) return "trace";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
    return "screenshot";
  }
  if (ext === ".webm" || ext === ".mp4") return "video";
  return "other";
}

/**
 * Defends against a hostile playwright.config.ts pointing an attachment at a
 * CI secret file via symlink and exfiltrating it through the artifact upload.
 * Resolves via realpath and requires the result to live under `allowedRoot`.
 */
export async function safeResolvedPath(
  attachmentPath: string,
  allowedRoot: string,
): Promise<string | null> {
  try {
    const resolved = await realpath(attachmentPath);
    const rootWithSep = allowedRoot.endsWith(sep)
      ? allowedRoot
      : allowedRoot + sep;
    if (resolved !== allowedRoot && !resolved.startsWith(rootWithSep)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

export async function safeSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return null;
  }
}
