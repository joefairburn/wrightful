import type { IngestResponse, TestResultPayload } from "../types.js";

const CLI_VERSION = "0.1.0";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function printHeader() {
  console.log(`Greenroom v${CLI_VERSION}\n`);
}

export function printReportInfo(filePath: string, testCount: number) {
  console.log(`Reading report... ${filePath} (${testCount} tests)`);
}

export function printCIInfo(ciProvider: string | null) {
  if (ciProvider) {
    console.log(`Detected CI: ${ciProvider}`);
  } else {
    console.log("Running locally (no CI detected)");
  }
}

export function printUploading(url: string) {
  console.log(`Uploading to ${url}...`);
}

export function printSuccess(
  response: IngestResponse,
  baseUrl: string,
  results: TestResultPayload[],
  durationMs: number,
) {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter(
    (r) => r.status === "failed" || r.status === "timedout",
  ).length;
  const flaky = results.filter((r) => r.status === "flaky").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  console.log("");
  if (response.duplicate) {
    console.log("Upload skipped (duplicate — already uploaded).");
  } else {
    console.log("Upload complete.");
  }
  console.log(`  Run URL: ${baseUrl}${response.runUrl}`);
  console.log(
    `  ${passed} passed / ${failed} failed / ${flaky} flaky / ${skipped} skipped`,
  );
  console.log(`  Duration: ${formatDuration(durationMs)}`);

  // Print failed tests
  const failedTests = results.filter(
    (r) => r.status === "failed" || r.status === "timedout",
  );
  if (failedTests.length > 0) {
    console.log(`\n${failedTests.length} failed test(s):`);
    for (const test of failedTests) {
      console.log(
        `  FAIL  ${test.title}${test.projectName ? ` (${test.projectName})` : ""} - ${formatDuration(test.durationMs)}`,
      );
      if (test.errorMessage) {
        const firstLine = test.errorMessage.split("\n")[0];
        console.log(`        ${firstLine}`);
      }
    }
  }
}

export function printError(message: string) {
  console.error(`\nError: ${message}`);
}
