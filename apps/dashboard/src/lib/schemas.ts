import { z } from "zod";
// Relative (not `@/`) so the reporter's wire-contract test can import this
// module cross-package without the dashboard's path alias.
import { isSafeContentType } from "./content-types";

/**
 * Wire-protocol schemas for the streaming-ingest API (v3).
 *
 * Mirror of `@wrightful/reporter`'s TS interfaces. Keep this file in sync
 * with that package whenever the reporter contract changes.
 */

export const TestAttemptSchema = z.object({
  attempt: z.number().int().min(0),
  status: z.enum(["passed", "failed", "timedout", "skipped"]),
  durationMs: z.number().int().min(0),
  errorMessage: z.string().nullable().optional(),
  errorStack: z.string().nullable().optional(),
});

export type TestAttemptInput = z.infer<typeof TestAttemptSchema>;

const TestResultSchema = z.object({
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

// Unix seconds. Optional and only honored in dev — production handlers
// reject it so a compromised API key can't fabricate historical rows. Used
// by the local seed script to backdate synthetic runs.
const BackdateSeconds = z.number().int().min(0).optional();

export const OpenRunPayloadSchema = z.object({
  idempotencyKey: z.string().min(1),
  run: z.object(RunMetaCommon),
  createdAt: BackdateSeconds,
});
export type OpenRunPayload = z.infer<typeof OpenRunPayloadSchema>;

export const AppendResultsPayloadSchema = z.object({
  results: z.array(TestResultSchema).min(1),
});
export type AppendResultsPayload = z.infer<typeof AppendResultsPayloadSchema>;

export const CompleteRunPayloadSchema = z.object({
  status: z.enum(["passed", "failed", "timedout", "interrupted"]),
  durationMs: z.number().int().min(0),
  completedAt: BackdateSeconds,
});
export type CompleteRunPayload = z.infer<typeof CompleteRunPayloadSchema>;

const ArtifactRequestSchema = z
  .object({
    testResultId: z.string().min(1),
    type: z.enum(["trace", "screenshot", "video", "visual", "other"]),
    name: z.string().min(1),
    // `contentType` is reflected back as a response header on the artifact
    // download endpoint, which is served from the dashboard origin. Anything
    // outside the safe set could be served as `text/html` (or SVG with
    // embedded script) and execute in the dashboard origin — see
    // `src/lib/content-types.ts`.
    contentType: z.string().min(1).refine(isSafeContentType, {
      message: "Unsupported contentType",
    }),
    sizeBytes: z.number().int().min(0),
    attempt: z.number().int().min(0).default(0),
    role: z.enum(["expected", "actual", "diff"]).optional(),
    snapshotName: z.string().min(1).max(255).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.type === "visual") {
      if (!a.role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["role"],
          message: "role is required when type is 'visual'",
        });
      }
      if (!a.snapshotName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["snapshotName"],
          message: "snapshotName is required when type is 'visual'",
        });
      }
    }
  });

export const RegisterArtifactsPayloadSchema = z.object({
  runId: z.string().min(1),
  artifacts: z.array(ArtifactRequestSchema).min(1),
});

export type RegisterArtifactsPayload = z.infer<
  typeof RegisterArtifactsPayloadSchema
>;
