// Wire-format types for the v3 streaming ingest API. Mirrors the Zod
// schemas in packages/dashboard/src/routes/api/schemas.ts; keep them in
// sync when changing the API contract.

import type { ArtifactType } from "./attachments.js";

export interface TestResultPayload {
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
