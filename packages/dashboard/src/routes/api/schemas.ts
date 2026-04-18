import { z } from "zod";

const TestResultSchema = z.object({
  // v2 addition: opaque client-generated key used to correlate each test
  // result in the request with the server-assigned testResultId returned in
  // the ingest response. Optional for v1 compatibility.
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
});

const RunMetadataSchema = z.object({
  ciProvider: z.string().nullable().optional(),
  ciBuildId: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  commitMessage: z.string().nullable().optional(),
  prNumber: z.number().int().nullable().optional(),
  repo: z.string().nullable().optional(),
  actor: z.string().nullable().optional(),
  status: z.enum(["passed", "failed", "timedout", "interrupted"]),
  durationMs: z.number().int().min(0),
  reporterVersion: z.string().nullable().optional(),
  playwrightVersion: z.string().nullable().optional(),
});

export const IngestPayloadSchema = z.object({
  idempotencyKey: z.string().min(1),
  run: RunMetadataSchema,
  results: z.array(TestResultSchema).min(0),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

const ArtifactRequestSchema = z.object({
  testResultId: z.string().min(1),
  type: z.enum(["trace", "screenshot", "video", "other"]),
  name: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().min(0),
});

export const RegisterArtifactsPayloadSchema = z.object({
  runId: z.string().min(1),
  artifacts: z.array(ArtifactRequestSchema).min(1),
});

export type RegisterArtifactsPayload = z.infer<
  typeof RegisterArtifactsPayloadSchema
>;
