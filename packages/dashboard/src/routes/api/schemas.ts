import { z } from "zod";

export const TestAttemptSchema = z.object({
  attempt: z.number().int().min(0),
  status: z.enum(["passed", "failed", "timedout", "skipped"]),
  durationMs: z.number().int().min(0),
  errorMessage: z.string().nullable().optional(),
  errorStack: z.string().nullable().optional(),
});

export type TestAttemptInput = z.infer<typeof TestAttemptSchema>;

const TestResultSchema = z.object({
  // Opaque client-generated key used to correlate each test result in the
  // request with the server-assigned testResultId returned in the response.
  // The reporter uses it to fire per-test artifact uploads.
  clientKey: z.string().min(1).optional(),
  testId: z.string().min(1),
  title: z.string().min(1),
  file: z.string().min(1),
  projectName: z.string().nullable().optional(),
  status: z.enum(["passed", "failed", "flaky", "skipped", "timedout"]),
  durationMs: z.number().int().min(0),
  retryCount: z.number().int().min(0).default(0),
  errorMessage: z.string().nullable().optional(),
  errorStack: z.string().nullable().optional(),
  workerIndex: z.number().int().min(0).optional(),
  tags: z.array(z.string()).default([]),
  annotations: z
    .array(
      z.object({
        type: z.string().min(1),
        description: z.string().nullable().optional(),
      }),
    )
    .default([]),
  // Playwright always runs at least once, so there's always ≥ 1 attempt.
  attempts: z.array(TestAttemptSchema).min(1),
});

export type TestResultInput = z.infer<typeof TestResultSchema>;

const PlannedTestSchema = z.object({
  testId: z.string().min(1),
  title: z.string().min(1),
  file: z.string().min(1),
  projectName: z.string().nullable().optional(),
});

export type PlannedTestInput = z.infer<typeof PlannedTestSchema>;

const RunMetaCommon = {
  ciProvider: z.string().nullable().optional(),
  ciBuildId: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  commitMessage: z.string().nullable().optional(),
  prNumber: z.number().int().nullable().optional(),
  repo: z.string().nullable().optional(),
  actor: z.string().nullable().optional(),
  reporterVersion: z.string().nullable().optional(),
  playwrightVersion: z.string().nullable().optional(),
  expectedTotalTests: z.number().int().min(0).nullable().optional(),
  plannedTests: z.array(PlannedTestSchema).default([]),
};

// ---------- v3 streaming endpoints ----------

export const OpenRunPayloadSchema = z.object({
  idempotencyKey: z.string().min(1),
  run: z.object(RunMetaCommon),
});
export type OpenRunPayload = z.infer<typeof OpenRunPayloadSchema>;

export const AppendResultsPayloadSchema = z.object({
  results: z.array(TestResultSchema).min(1),
});
export type AppendResultsPayload = z.infer<typeof AppendResultsPayloadSchema>;

export const CompleteRunPayloadSchema = z.object({
  status: z.enum(["passed", "failed", "timedout", "interrupted"]),
  durationMs: z.number().int().min(0),
});
export type CompleteRunPayload = z.infer<typeof CompleteRunPayloadSchema>;

const ArtifactRequestSchema = z.object({
  testResultId: z.string().min(1),
  type: z.enum(["trace", "screenshot", "video", "other"]),
  name: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().min(0),
  attempt: z.number().int().min(0).default(0),
});

export const RegisterArtifactsPayloadSchema = z.object({
  runId: z.string().min(1),
  artifacts: z.array(ArtifactRequestSchema).min(1),
});

export type RegisterArtifactsPayload = z.infer<
  typeof RegisterArtifactsPayloadSchema
>;
