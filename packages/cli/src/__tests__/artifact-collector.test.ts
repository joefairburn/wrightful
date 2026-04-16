import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAttachment,
  collectArtifacts,
} from "../lib/artifact-collector.js";
import { computeTestId } from "../lib/test-id.js";
import type { PlaywrightReport } from "../types.js";

describe("classifyAttachment", () => {
  it("recognizes traces via content type", () => {
    expect(classifyAttachment("trace.zip", "application/zip")).toBe("trace");
  });

  it("recognizes screenshots", () => {
    expect(classifyAttachment("shot.png", "image/png")).toBe("screenshot");
  });

  it("recognizes videos", () => {
    expect(classifyAttachment("recording.webm", "video/webm")).toBe("video");
  });

  it("falls back to `other` for unknown types", () => {
    expect(classifyAttachment("debug.log", "text/plain")).toBe("other");
  });

  it("classifies by extension when content type is generic", () => {
    expect(classifyAttachment("trace.zip", "application/octet-stream")).toBe(
      "trace",
    );
    expect(classifyAttachment("x.webm", "application/octet-stream")).toBe(
      "video",
    );
  });
});

describe("collectArtifacts", () => {
  let tmpDir: string;
  let tracePath: string;
  let screenshotPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wrightful-artifacts-test-"));
    tracePath = join(tmpDir, "trace.zip");
    screenshotPath = join(tmpDir, "shot.png");
    await writeFile(tracePath, Buffer.alloc(128, 0x41));
    await writeFile(screenshotPath, Buffer.alloc(64, 0x42));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeReport(opts: {
    status: "expected" | "unexpected" | "flaky" | "skipped";
    attachments: Array<{ name: string; contentType: string; path?: string }>;
  }): PlaywrightReport {
    return {
      config: {
        rootDir: "/tmp",
        version: "1.50.0",
        projects: [{ id: "chromium", name: "chromium" }],
      },
      stats: {
        startTime: "2026-01-01T00:00:00.000Z",
        duration: 1000,
        expected: 0,
        skipped: 0,
        unexpected: 1,
        flaky: 0,
      },
      errors: [],
      suites: [
        {
          title: "tests/payment.spec.ts",
          file: "tests/payment.spec.ts",
          line: 0,
          column: 0,
          specs: [],
          suites: [
            {
              title: "Payment",
              file: "tests/payment.spec.ts",
              line: 1,
              column: 0,
              specs: [
                {
                  title: "checkout",
                  ok: true,
                  tags: [],
                  id: "pw-1",
                  file: "tests/payment.spec.ts",
                  line: 2,
                  column: 0,
                  tests: [
                    {
                      timeout: 30000,
                      annotations: [],
                      expectedStatus: "passed",
                      projectId: "chromium",
                      projectName: "chromium",
                      status: opts.status,
                      results: [
                        {
                          workerIndex: 0,
                          status: "failed",
                          duration: 1000,
                          errors: [],
                          retry: 0,
                          startTime: "2026-01-01T00:00:00.000Z",
                          attachments: opts.attachments,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it("returns an empty manifest in `none` mode", async () => {
    const report = makeReport({
      status: "unexpected",
      attachments: [
        { name: "trace.zip", contentType: "application/zip", path: tracePath },
      ],
    });
    const manifest = await collectArtifacts(report, "none");
    expect(manifest.artifacts).toEqual([]);
  });

  it("ignores attachments for passing tests in `failed` mode", async () => {
    const report = makeReport({
      status: "expected",
      attachments: [
        { name: "trace.zip", contentType: "application/zip", path: tracePath },
      ],
    });
    const manifest = await collectArtifacts(report, "failed");
    expect(manifest.artifacts).toEqual([]);
  });

  it("includes attachments for failing tests in `failed` mode", async () => {
    const report = makeReport({
      status: "unexpected",
      attachments: [
        { name: "trace.zip", contentType: "application/zip", path: tracePath },
        { name: "shot.png", contentType: "image/png", path: screenshotPath },
      ],
    });
    const manifest = await collectArtifacts(report, "failed");
    expect(manifest.artifacts).toHaveLength(2);
    const trace = manifest.artifacts.find((a) => a.name === "trace.zip");
    expect(trace?.type).toBe("trace");
    expect(trace?.sizeBytes).toBe(128);
    const shot = manifest.artifacts.find((a) => a.name === "shot.png");
    expect(shot?.type).toBe("screenshot");
    expect(shot?.sizeBytes).toBe(64);
  });

  it("uses testId as clientKey (walking file-level + nested suite titles)", async () => {
    const report = makeReport({
      status: "unexpected",
      attachments: [
        { name: "trace.zip", contentType: "application/zip", path: tracePath },
      ],
    });
    const manifest = await collectArtifacts(report, "failed");
    // Matches parser.ts: titlePath is built by walking every non-empty suite title,
    // including the file-level suite, before appending the spec title.
    const expected = computeTestId(
      "tests/payment.spec.ts",
      ["tests/payment.spec.ts", "Payment", "checkout"],
      "chromium",
    );
    expect(manifest.artifacts[0].clientKey).toBe(expected);
  });

  it("includes passing-test attachments in `all` mode", async () => {
    const report = makeReport({
      status: "expected",
      attachments: [
        { name: "shot.png", contentType: "image/png", path: screenshotPath },
      ],
    });
    const manifest = await collectArtifacts(report, "all");
    expect(manifest.artifacts).toHaveLength(1);
  });

  it("skips attachments without a file path", async () => {
    const report = makeReport({
      status: "unexpected",
      attachments: [{ name: "inline", contentType: "text/plain" }],
    });
    const manifest = await collectArtifacts(report, "all");
    expect(manifest.artifacts).toEqual([]);
  });

  it("skips attachments whose file is missing on disk", async () => {
    const missingPath = join(tmpDir, "does-not-exist.zip");
    const report = makeReport({
      status: "unexpected",
      attachments: [
        {
          name: "missing.zip",
          contentType: "application/zip",
          path: missingPath,
        },
      ],
    });
    const manifest = await collectArtifacts(report, "all");
    expect(manifest.artifacts).toEqual([]);
  });
});
