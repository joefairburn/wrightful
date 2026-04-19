import { readFile } from "node:fs/promises";
import { computeTestId } from "./test-id.js";
import type {
  PlaywrightReport,
  PlaywrightSuite,
  TestResultPayload,
  RunPayload,
} from "../types.js";

function mapStatus(
  testOutcome: "expected" | "unexpected" | "flaky" | "skipped",
  lastResultStatus?: string,
): "passed" | "failed" | "flaky" | "skipped" | "timedout" {
  switch (testOutcome) {
    case "expected":
      return "passed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    case "unexpected":
      return lastResultStatus === "timedOut" ? "timedout" : "failed";
    default:
      return "failed";
  }
}

function computeRunStatus(
  results: TestResultPayload[],
): "passed" | "failed" | "timedout" | "interrupted" {
  for (const r of results) {
    if (r.status === "failed") return "failed";
    if (r.status === "timedout") return "failed";
  }
  return "passed";
}

function parseSuites(
  suites: PlaywrightSuite[],
  parentTitlePath: string[],
): TestResultPayload[] {
  const results: TestResultPayload[] = [];

  for (const suite of suites) {
    // Build title path — skip empty titles (file-level suites sometimes have path as title)
    const titlePath = suite.title
      ? [...parentTitlePath, suite.title]
      : parentTitlePath;

    // Process specs at this level
    for (const spec of suite.specs) {
      const specTitlePath = [...titlePath, spec.title];

      for (const test of spec.tests) {
        const projectName = test.projectName || "";
        const testId = computeTestId(spec.file, specTitlePath, projectName);
        const lastResult = test.results[test.results.length - 1];

        // For flaky tests, get error from the failing result
        const failingResult = test.results.find(
          (r) => r.status === "failed" || r.status === "timedOut",
        );

        const status = mapStatus(test.status, lastResult?.status);
        const errorSource = status === "flaky" ? failingResult : lastResult;

        results.push({
          clientKey: testId,
          testId,
          title: specTitlePath.join(" > "),
          file: spec.file,
          projectName: projectName || null,
          status,
          durationMs: Math.round(
            test.results.reduce((sum, r) => sum + r.duration, 0),
          ),
          retryCount: test.results.length - 1,
          errorMessage: errorSource?.errors?.[0]?.message ?? null,
          errorStack: errorSource?.errors?.[0]?.stack ?? null,
          // Playwright sets workerIndex to -1 for results that never got
          // dispatched to a worker (e.g. tests skipped before run). The
          // ingest schema requires >=0, so drop negatives rather than
          // forwarding them.
          workerIndex:
            lastResult && lastResult.workerIndex >= 0
              ? lastResult.workerIndex
              : 0,
          tags: spec.tags || [],
          annotations: test.annotations || [],
        });
      }
    }

    // Recurse into child suites
    if (suite.suites) {
      results.push(...parseSuites(suite.suites, titlePath));
    }
  }

  return results;
}

export interface ParsedReport {
  results: TestResultPayload[];
  run: Omit<
    RunPayload,
    | "ciProvider"
    | "ciBuildId"
    | "branch"
    | "environment"
    | "commitSha"
    | "commitMessage"
    | "prNumber"
    | "repo"
    | "actor"
    | "reporterVersion"
  >;
  playwrightVersion: string;
  /** The raw Playwright report — retained so the artifact collector can walk attachments without re-reading the file. */
  report: PlaywrightReport;
}

export async function parseReport(filePath: string): Promise<ParsedReport> {
  const content = await readFile(filePath, "utf-8");
  let report: PlaywrightReport;
  try {
    report = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse JSON from ${filePath}`);
  }

  if (!report.suites || !report.stats) {
    throw new Error(
      "Invalid Playwright report format. Ensure you are using the JSON reporter.",
    );
  }

  const results = parseSuites(report.suites, []);

  return {
    results,
    run: {
      status: computeRunStatus(results),
      durationMs: Math.round(report.stats.duration),
      playwrightVersion: report.config.version || "unknown",
    },
    playwrightVersion: report.config.version || "unknown",
    report,
  };
}
