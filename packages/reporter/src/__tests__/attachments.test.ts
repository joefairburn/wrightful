import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyAttachment,
  parseSnapshotAttachment,
  safeResolvedPath,
  safeSize,
} from "../attachments.js";

describe("classifyAttachment", () => {
  it("classifies application/zip as trace", () => {
    expect(classifyAttachment("trace.zip", "application/zip")).toBe("trace");
  });

  it("classifies application/x-zip-compressed as trace", () => {
    expect(
      classifyAttachment("trace.zip", "application/x-zip-compressed"),
    ).toBe("trace");
  });

  it("uses content-type prefix for image/*", () => {
    expect(classifyAttachment("shot.png", "image/png")).toBe("screenshot");
    expect(classifyAttachment("shot.webp", "image/webp")).toBe("screenshot");
  });

  it("uses content-type prefix for video/*", () => {
    expect(classifyAttachment("clip.webm", "video/webm")).toBe("video");
    expect(classifyAttachment("clip.mp4", "video/mp4")).toBe("video");
  });

  it("falls back to extension for screenshots when content-type is missing", () => {
    expect(classifyAttachment("shot.png", "")).toBe("screenshot");
    expect(classifyAttachment("shot.jpg", "")).toBe("screenshot");
    expect(classifyAttachment("shot.jpeg", "")).toBe("screenshot");
    expect(classifyAttachment("shot.webp", "")).toBe("screenshot");
  });

  it("falls back to extension for videos when content-type is missing", () => {
    expect(classifyAttachment("clip.webm", "")).toBe("video");
    expect(classifyAttachment("clip.mp4", "")).toBe("video");
  });

  it("treats a .zip without 'trace' in the name as other, not trace", () => {
    expect(classifyAttachment("bundle.zip", "")).toBe("other");
  });

  it("treats a .zip with 'trace' in the name as trace", () => {
    expect(classifyAttachment("my-trace.zip", "")).toBe("trace");
  });

  it("returns 'other' for unknown types", () => {
    expect(classifyAttachment("notes.txt", "text/plain")).toBe("other");
    expect(classifyAttachment("unknown", "")).toBe("other");
  });

  it("classifies all snapshot-named PNGs as plain screenshot — promotion happens later in collectArtifacts", () => {
    expect(
      classifyAttachment("hero-chromium-linux-actual.png", "image/png"),
    ).toBe("screenshot");
    expect(
      classifyAttachment("hero-chromium-linux-expected.png", "image/png"),
    ).toBe("screenshot");
    expect(
      classifyAttachment("hero-chromium-linux-diff.png", "image/png"),
    ).toBe("screenshot");
  });
});

describe("parseSnapshotAttachment", () => {
  it("recognises Playwright's expected/actual/diff suffixes", () => {
    expect(parseSnapshotAttachment("hero-chromium-linux-expected.png")).toEqual(
      { snapshotName: "hero-chromium-linux", role: "expected" },
    );
    expect(parseSnapshotAttachment("hero-chromium-linux-actual.png")).toEqual({
      snapshotName: "hero-chromium-linux",
      role: "actual",
    });
    expect(parseSnapshotAttachment("hero-chromium-linux-diff.png")).toEqual({
      snapshotName: "hero-chromium-linux",
      role: "diff",
    });
  });

  it("handles auto-indexed unnamed snapshots", () => {
    expect(parseSnapshotAttachment("test-name-1-actual.png")).toEqual({
      snapshotName: "test-name-1",
      role: "actual",
    });
  });

  it("strips a leading directory before parsing", () => {
    expect(
      parseSnapshotAttachment("/tmp/results/hero-chromium-linux-diff.png"),
    ).toEqual({ snapshotName: "hero-chromium-linux", role: "diff" });
  });

  it("returns null for non-PNG suffixes", () => {
    expect(parseSnapshotAttachment("hero-actual.jpg")).toBeNull();
    expect(parseSnapshotAttachment("hero-actual.txt")).toBeNull();
  });

  it("returns null for unrelated -actual that isn't a Playwright snapshot", () => {
    expect(parseSnapshotAttachment("just-a-screenshot.png")).toBeNull();
  });

  it("requires a non-empty base name before the suffix", () => {
    expect(parseSnapshotAttachment("-actual.png")).toBeNull();
  });
});

describe("safeResolvedPath", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "wrightful-attach-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the resolved path for a file inside the root", async () => {
    const file = join(root, "trace.zip");
    await writeFile(file, "x");
    const resolved = await safeResolvedPath(file, root);
    expect(resolved).toBe(file);
  });

  it("returns null for a file outside the root", async () => {
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "wrightful-out-")),
    );
    const file = join(outside, "leak.txt");
    await writeFile(file, "secret");

    const resolved = await safeResolvedPath(file, root);
    expect(resolved).toBeNull();

    await rm(outside, { recursive: true, force: true });
  });

  it("returns null for a symlink inside the root that points outside", async () => {
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "wrightful-symtarget-")),
    );
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret");

    const link = join(root, "sneaky-link");
    await symlink(secret, link);

    const resolved = await safeResolvedPath(link, root);
    expect(resolved).toBeNull();

    await rm(outside, { recursive: true, force: true });
  });

  it("does not accept a sibling directory that shares the root's prefix", async () => {
    // e.g. allowedRoot=/tmp/abc, path=/tmp/abcxyz/file should NOT match.
    const sibling = `${root}xyz`;
    await mkdir(sibling, { recursive: true });
    const file = join(sibling, "oops.txt");
    await writeFile(file, "x");

    const resolved = await safeResolvedPath(file, root);
    expect(resolved).toBeNull();

    await rm(sibling, { recursive: true, force: true });
  });

  it("handles a root path that already ends with a separator", async () => {
    const file = join(root, "trace.zip");
    await writeFile(file, "x");
    const resolved = await safeResolvedPath(file, root + sep);
    expect(resolved).toBe(file);
  });

  it("returns null for a path that does not exist", async () => {
    const resolved = await safeResolvedPath(join(root, "missing"), root);
    expect(resolved).toBeNull();
  });
});

describe("safeSize", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wrightful-size-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the byte size of an existing file", async () => {
    const file = join(dir, "a.bin");
    await writeFile(file, "abcdef");
    expect(await safeSize(file)).toBe(6);
  });

  it("returns null when the file is missing", async () => {
    expect(await safeSize(join(dir, "missing"))).toBeNull();
  });
});
