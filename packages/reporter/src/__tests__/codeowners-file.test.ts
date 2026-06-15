import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CODEOWNERS_CANDIDATES,
  MAX_CODEOWNERS_BYTES,
  readCodeowners,
} from "../codeowners-file.js";

/**
 * `readCodeowners` locates the repo's CODEOWNERS at onBegin (roadmap 2.3). It
 * is best-effort: a missing/unreadable/oversize file resolves to `null` (the
 * field is then omitted from the open-run payload) and it never throws.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wrightful-codeowners-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeAt(relPath: string, contents: string): Promise<void> {
  const full = join(root, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, contents, "utf8");
}

describe("readCodeowners", () => {
  it("returns null when no CODEOWNERS file exists", async () => {
    expect(await readCodeowners(root)).toBeNull();
  });

  it("reads the repo-root CODEOWNERS", async () => {
    await writeAt("CODEOWNERS", "* @everyone\n");
    expect(await readCodeowners(root)).toBe("* @everyone\n");
  });

  it("reads .github/CODEOWNERS", async () => {
    await writeAt(".github/CODEOWNERS", "*.ts @ts\n");
    expect(await readCodeowners(root)).toBe("*.ts @ts\n");
  });

  it("reads docs/CODEOWNERS", async () => {
    await writeAt("docs/CODEOWNERS", "/docs @docs\n");
    expect(await readCodeowners(root)).toBe("/docs @docs\n");
  });

  it("prefers .github/CODEOWNERS over the others (first-found-wins)", async () => {
    await writeAt(".github/CODEOWNERS", "github @gh\n");
    await writeAt("CODEOWNERS", "root @root\n");
    await writeAt("docs/CODEOWNERS", "docs @docs\n");
    expect(await readCodeowners(root)).toBe("github @gh\n");
    // Confirm the precedence order matches the documented constant.
    expect(CODEOWNERS_CANDIDATES[0]).toBe(".github/CODEOWNERS");
  });

  it("prefers the repo-root CODEOWNERS over docs/", async () => {
    await writeAt("CODEOWNERS", "root @root\n");
    await writeAt("docs/CODEOWNERS", "docs @docs\n");
    expect(await readCodeowners(root)).toBe("root @root\n");
  });

  it("skips a file larger than the byte cap (returns null, doesn't truncate)", async () => {
    await writeAt("CODEOWNERS", "x".repeat(MAX_CODEOWNERS_BYTES + 1));
    expect(await readCodeowners(root)).toBeNull();
  });

  it("falls back to process.cwd() when rootDir is null without throwing", async () => {
    // There is (almost certainly) no CODEOWNERS at the test runner's cwd; the
    // contract is just that a null rootDir resolves cleanly rather than throwing.
    await expect(readCodeowners(null)).resolves.not.toThrow();
  });
});
