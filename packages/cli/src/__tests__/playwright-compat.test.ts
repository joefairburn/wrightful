import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { parseReport } from "../lib/parser.js";

const BASE_FIXTURE = resolve(
  import.meta.dirname,
  "../../test-fixtures/sample-report.json",
);

const FUTURE_FIXTURE = resolve(
  import.meta.dirname,
  "../../test-fixtures/sample-report-future.json",
);

describe("Playwright forward compatibility", () => {
  it("parses a report with extra fields from newer Playwright versions", async () => {
    const result = await parseReport(FUTURE_FIXTURE);
    expect(result.results).toHaveLength(4);
    expect(result.playwrightVersion).toBe("1.59.1");
  });

  it("produces identical parsed output regardless of extra fields", async () => {
    const base = await parseReport(BASE_FIXTURE);
    const future = await parseReport(FUTURE_FIXTURE);

    // Same number of test results
    expect(future.results).toHaveLength(base.results.length);

    // Same test IDs (stable across versions)
    const baseIds = base.results.map((r) => r.testId).sort();
    const futureIds = future.results.map((r) => r.testId).sort();
    expect(futureIds).toEqual(baseIds);

    // Same statuses
    for (const baseResult of base.results) {
      const futureResult = future.results.find(
        (r) => r.testId === baseResult.testId,
      );
      expect(futureResult).toBeDefined();
      expect(futureResult!.status).toBe(baseResult.status);
      expect(futureResult!.durationMs).toBe(baseResult.durationMs);
      expect(futureResult!.retryCount).toBe(baseResult.retryCount);
      expect(futureResult!.errorMessage).toBe(baseResult.errorMessage);
      expect(futureResult!.tags).toEqual(baseResult.tags);
      expect(futureResult!.annotations).toEqual(baseResult.annotations);
    }

    // Same run-level data
    expect(future.run.status).toBe(base.run.status);
    expect(future.run.durationMs).toBe(base.run.durationMs);
  });

  it("handles unknown top-level keys without errors", async () => {
    const tmp = "/tmp/wrightful-unknown-keys.json";
    const report = {
      config: {
        rootDir: "/project",
        version: "2.0.0",
        projects: [{ id: "chromium", name: "chromium" }],
      },
      suites: [
        {
          title: "test.spec.ts",
          file: "test.spec.ts",
          line: 0,
          column: 0,
          specs: [
            {
              title: "basic test",
              ok: true,
              tags: [],
              id: "1",
              file: "test.spec.ts",
              line: 1,
              column: 0,
              tests: [
                {
                  timeout: 30000,
                  annotations: [],
                  expectedStatus: "passed",
                  projectId: "chromium",
                  projectName: "chromium",
                  results: [
                    {
                      workerIndex: 0,
                      status: "passed",
                      duration: 100,
                      errors: [],
                      retry: 0,
                      startTime: "2026-01-01T00:00:00.000Z",
                      attachments: [],
                    },
                  ],
                  status: "expected",
                },
              ],
            },
          ],
          suites: [],
        },
      ],
      stats: {
        startTime: "2026-01-01T00:00:00.000Z",
        duration: 100,
        expected: 1,
        skipped: 0,
        unexpected: 0,
        flaky: 0,
      },
      errors: [],
      // Unknown future keys
      metadata: { totalTime: 500, globalSetupDuration: 200 },
      projectSetups: [{ name: "chromium", status: "done" }],
      customReporterData: { version: 3, format: "extended" },
    };
    await writeFile(tmp, JSON.stringify(report));
    try {
      const result = await parseReport(tmp);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe("passed");
      expect(result.playwrightVersion).toBe("2.0.0");
    } finally {
      await unlink(tmp);
    }
  });

  it("handles extra fields on suites and specs", async () => {
    const tmp = "/tmp/wrightful-extra-suite-fields.json";
    const report = {
      config: {
        rootDir: "/project",
        version: "1.60.0",
        projects: [{ id: "chromium", name: "chromium" }],
      },
      suites: [
        {
          title: "test.spec.ts",
          file: "test.spec.ts",
          line: 0,
          column: 0,
          specs: [
            {
              title: "test with extra spec fields",
              ok: true,
              tags: ["@new"],
              id: "1",
              file: "test.spec.ts",
              line: 1,
              column: 0,
              // Extra fields that might appear in future Playwright versions
              location: { file: "test.spec.ts", line: 1, column: 0 },
              retries: 2,
              timeout: 30000,
              tests: [
                {
                  timeout: 30000,
                  annotations: [],
                  expectedStatus: "passed",
                  projectId: "chromium",
                  projectName: "chromium",
                  // Extra test-level fields
                  repeatEachIndex: 0,
                  titlePath: ["test.spec.ts", "test with extra spec fields"],
                  results: [
                    {
                      workerIndex: 0,
                      parallelIndex: 0,
                      status: "passed",
                      duration: 200,
                      errors: [],
                      retry: 0,
                      startTime: "2026-01-01T00:00:00.000Z",
                      attachments: [],
                      stdout: [],
                      stderr: [],
                      steps: [],
                    },
                  ],
                  status: "expected",
                },
              ],
            },
          ],
          // Extra suite-level fields
          entries: [],
          location: { file: "test.spec.ts", line: 0, column: 0 },
          suites: [],
        },
      ],
      stats: {
        startTime: "2026-01-01T00:00:00.000Z",
        duration: 200,
        expected: 1,
        skipped: 0,
        unexpected: 0,
        flaky: 0,
      },
      errors: [],
    };
    await writeFile(tmp, JSON.stringify(report));
    try {
      const result = await parseReport(tmp);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe("passed");
      expect(result.results[0].tags).toEqual(["@new"]);
    } finally {
      await unlink(tmp);
    }
  });
});
