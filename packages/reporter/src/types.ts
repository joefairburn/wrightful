// Wire-format types for the v3 streaming ingest API. Mirrors the Zod
// schemas in packages/dashboard/src/routes/api/schemas.ts; keep them in
// sync when changing the API contract.

import type { ArtifactType, SnapshotRole } from "./attachments.js";

export interface TestAttemptPayload {
  /** 0 = initial attempt, 1 = first retry, … */
  attempt: number;
  /** Single-attempt outcome; `flaky` lives only on the aggregate. */
  status: "passed" | "failed" | "timedout" | "skipped";
  durationMs: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface TestResultPayload {
  clientKey: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: "passed" | "failed" | "flaky" | "skipped" | "timedout";
  durationMs: number;
  retryCount: number;
  /** Aggregate error (last attempt for failed/timedout, first failing for flaky). */
  errorMessage: string | null;
  errorStack: string | null;
  workerIndex: number;
  tags: string[];
  annotations: Array<{ type: string; description?: string }>;
  /** One entry per Playwright attempt. Always ≥ 1 — Playwright always runs at least once. */
  attempts: TestAttemptPayload[];
}

export interface PlannedTestDescriptor {
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
}

export interface OpenRunPayload {
  idempotencyKey: string;
  run: {
    ciProvider: string | null;
    ciBuildId: string | null;
    branch: string | null;
    environment: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    prNumber: number | null;
    repo: string | null;
    actor: string | null;
    reporterVersion: string;
    playwrightVersion: string;
    expectedTotalTests: number;
    plannedTests: PlannedTestDescriptor[];
  };
}

export interface AppendResultsPayload {
  results: TestResultPayload[];
}

export interface CompleteRunPayload {
  status: "passed" | "failed" | "timedout" | "interrupted";
  durationMs: number;
}

export interface ArtifactUpload {
  artifactId: string;
  uploadUrl: string;
  r2Key: string;
}

export interface ArtifactRegistration {
  testResultId: string;
  type: ArtifactType;
  name: string;
  contentType: string;
  sizeBytes: number;
  /** Playwright attempt index (0 = initial, 1 = first retry, …). */
  attempt: number;
  /**
   * For `type: "visual"` artifacts: which side of the snapshot triple this
   * file is. Required when `type === "visual"`, ignored otherwise.
   */
  role?: SnapshotRole;
  /**
   * For `type: "visual"` artifacts: the shared base name that groups the
   * expected/actual/diff triple within a single test attempt (e.g.
   * `hero-chromium-linux`). Required when `type === "visual"`.
   */
  snapshotName?: string;
}

export type ArtifactMode = "all" | "failed" | "none";

export interface ReporterOptions {
  /** Dashboard base URL, e.g. https://wrightful.example.com */
  url?: string;
  /** Bearer API key. Falls back to env WRIGHTFUL_TOKEN. */
  token?: string;
  /** Max results per flush. Defaults to 20. */
  batchSize?: number;
  /** Max delay between flushes (ms). Defaults to 500. */
  flushIntervalMs?: number;
  /** Environment tag for the run. */
  environment?: string;
  /**
   * Which tests' attachments to upload. `failed` (default): only upload
   * for unexpected failures + flaky retries. `all`: upload every test's
   * attachments. `none`: skip artifact uploads entirely.
   */
  artifacts?: ArtifactMode;
}
