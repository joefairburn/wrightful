import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { computeTestId } from "./test-id.js";
import type {
  PlaywrightReport,
  PlaywrightSuite,
  PlaywrightTestResult,
} from "../types.js";

export type ArtifactMode = "all" | "failed" | "none";
export type ArtifactType = "trace" | "screenshot" | "video" | "other";

export interface ArtifactManifestEntry {
  /** Matches the `clientKey` sent on each ingest result (currently equal to `testId`). */
  clientKey: string;
  type: ArtifactType;
  name: string;
  contentType: string;
  localPath: string;
  sizeBytes: number;
}

export interface ArtifactManifest {
  artifacts: ArtifactManifestEntry[];
}

/** Map a Playwright attachment onto our coarse artifact type based on content type / extension. */
export function classifyAttachment(
  name: string,
  contentType: string,
): ArtifactType {
  const ct = contentType.toLowerCase();
  if (ct === "application/zip" || ct === "application/x-zip-compressed") {
    // Playwright trace files are always zips named trace*.zip
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
 * `failed` mode uploads artifacts only for tests that need them: unexpected
 * failures, flaky retries, and timed-out tests. Matches Playwright's
 * recommended `trace: 'on-first-retry'` / `screenshot: 'only-on-failure'`
 * defaults.
 */
function shouldIncludeTest(
  mode: ArtifactMode,
  testStatus: "expected" | "unexpected" | "flaky" | "skipped",
): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  return testStatus === "unexpected" || testStatus === "flaky";
}

/**
 * Resolve `attachmentPath` via realpath and require the result to live under
 * `allowedRoot`. This defends against a hostile `playwright.config.ts` (or
 * compromised test run) pointing an attachment at `/etc/passwd` or a CI
 * secret file via a symlink and exfiltrating it through the artifact upload.
 */
async function safeResolvedPath(
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

async function safeSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return null;
  }
}

async function walkSuites(
  suites: PlaywrightSuite[],
  parentTitlePath: string[],
  mode: ArtifactMode,
  allowedRoot: string,
  out: ArtifactManifestEntry[],
): Promise<void> {
  for (const suite of suites) {
    const titlePath = suite.title
      ? [...parentTitlePath, suite.title]
      : parentTitlePath;

    for (const spec of suite.specs) {
      const specTitlePath = [...titlePath, spec.title];

      for (const test of spec.tests) {
        if (!shouldIncludeTest(mode, test.status)) continue;

        const projectName = test.projectName || "";
        const clientKey = computeTestId(spec.file, specTitlePath, projectName);

        for (const result of test.results) {
          await collectResult(result, clientKey, allowedRoot, out);
        }
      }
    }

    if (suite.suites) {
      await walkSuites(suite.suites, titlePath, mode, allowedRoot, out);
    }
  }
}

async function collectResult(
  result: PlaywrightTestResult,
  clientKey: string,
  allowedRoot: string,
  out: ArtifactManifestEntry[],
): Promise<void> {
  for (const attachment of result.attachments ?? []) {
    // We only upload attachments backed by an on-disk file. Inline `body`
    // attachments are ignored — they're rare and typically diagnostic text
    // Playwright embeds directly in the report.
    if (!attachment.path) continue;

    const resolved = await safeResolvedPath(attachment.path, allowedRoot);
    if (resolved === null) continue;

    const size = await safeSize(resolved);
    if (size === null) continue;

    out.push({
      clientKey,
      type: classifyAttachment(attachment.name, attachment.contentType),
      name: attachment.name,
      contentType: attachment.contentType,
      localPath: resolved,
      sizeBytes: size,
    });
  }
}

export async function collectArtifacts(
  report: PlaywrightReport,
  mode: ArtifactMode,
  options: { allowedRoot?: string } = {},
): Promise<ArtifactManifest> {
  if (mode === "none") return { artifacts: [] };
  const allowedRoot = await realpath(
    resolve(options.allowedRoot ?? process.cwd()),
  );
  const out: ArtifactManifestEntry[] = [];
  await walkSuites(report.suites, [], mode, allowedRoot, out);
  return { artifacts: out };
}
