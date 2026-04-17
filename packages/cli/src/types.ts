// --- Playwright JSON Report types (input) ---
//
// These types are hand-written intentionally. The CLI must not depend on
// @playwright/test (which pulls browser binaries as transitive deps).
// They represent the subset of Playwright's JSON reporter output that
// Wrightful actually uses — roughly 15 fields out of 50+.
//
// The parser (lib/parser.ts) is designed to be resilient to additive changes:
// it uses optional chaining and defaults, so new fields from newer Playwright
// versions are silently ignored. See __tests__/playwright-compat.test.ts for
// the forward-compatibility contract.
//
// Last verified against: Playwright 1.59.1 JSONReport interfaces
// (node_modules/playwright/types/testReporter.d.ts)

export interface PlaywrightReport {
  config: {
    rootDir: string;
    version?: string;
    shard?: { current: number; total: number };
    projects: Array<{
      id: string;
      name: string;
    }>;
  };
  suites: PlaywrightSuite[];
  stats: {
    startTime: string;
    duration: number;
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
  errors: Array<{
    message?: string;
    stack?: string;
  }>;
}

export interface PlaywrightSuite {
  title: string;
  file: string;
  line: number;
  column: number;
  specs: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

export interface PlaywrightSpec {
  title: string;
  ok: boolean;
  tags: string[];
  id: string;
  file: string;
  line: number;
  column: number;
  tests: PlaywrightTest[];
}

export interface PlaywrightTest {
  timeout: number;
  annotations: Array<{ type: string; description?: string }>;
  expectedStatus: string;
  projectId: string;
  projectName: string;
  results: PlaywrightTestResult[];
  status: "expected" | "unexpected" | "flaky" | "skipped";
}

export interface PlaywrightTestResult {
  workerIndex: number;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  error?: { message?: string; stack?: string };
  errors: Array<{ message?: string; stack?: string }>;
  retry: number;
  startTime: string;
  attachments: Array<{
    name: string;
    contentType: string;
    path?: string;
    body?: string;
  }>;
}

// --- CI detection types ---

export interface CIInfo {
  ciProvider: string | null;
  ciBuildId: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  repo: string | null;
}

// --- Ingest payload types (output) ---

export interface IngestPayload {
  idempotencyKey: string;
  run: RunPayload;
  results: TestResultPayload[];
}

export interface RunPayload {
  ciProvider: string | null;
  ciBuildId: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  repo: string | null;
  status: "passed" | "failed" | "timedout" | "interrupted";
  durationMs: number;
  reporterVersion: string;
  playwrightVersion: string;
}

export interface TestResultPayload {
  /**
   * Opaque identifier chosen by the CLI, returned alongside the server-assigned
   * testResultId in the ingest response. Used to attach artifacts after upload.
   * Currently equals `testId`; kept as a separate field so the correlation
   * scheme can evolve without a wire-format change.
   */
  clientKey: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: "passed" | "failed" | "flaky" | "skipped" | "timedout";
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  errorStack: string | null;
  workerIndex: number;
  tags: string[];
  annotations: Array<{ type: string; description?: string }>;
}

export interface IngestResponse {
  runId: string;
  runUrl: string;
  duplicate?: boolean;
  /** Present on v2+ responses; maps each CLI-supplied clientKey to its DB id. */
  results?: Array<{ clientKey: string; testResultId: string }>;
}

export interface WrightfulConfig {
  url: string;
  token: string;
  artifacts: "all" | "failed" | "none";
}
