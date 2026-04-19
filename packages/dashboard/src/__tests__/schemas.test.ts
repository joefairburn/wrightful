import { describe, it, expect } from "vitest";
import {
  OpenRunPayloadSchema,
  AppendResultsPayloadSchema,
  CompleteRunPayloadSchema,
  RegisterArtifactsPayloadSchema,
} from "../routes/api/schemas";

const validTestResult = {
  clientKey: "ck-abc-0",
  testId: "a1b2c3d4e5f67890",
  title: "Payment flow > checkout",
  file: "tests/payment.spec.ts",
  projectName: "chromium",
  status: "passed",
  durationMs: 1234,
  retryCount: 0,
  errorMessage: null,
  errorStack: null,
  workerIndex: 0,
  tags: ["@smoke"],
  annotations: [{ type: "issue", description: "GH-123" }],
};

describe("OpenRunPayloadSchema", () => {
  const validPayload = {
    idempotencyKey: "test-key-1",
    run: {
      ciProvider: "github-actions",
      ciBuildId: "12345",
      branch: "main",
      environment: "staging",
      commitSha: "abc123",
      commitMessage: "fix things",
      prNumber: 42,
      repo: "org/repo",
      actor: "octocat",
      reporterVersion: "0.1.0",
      playwrightVersion: "1.50.0",
    },
  };

  it("accepts a valid payload", () => {
    expect(OpenRunPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it("rejects empty idempotencyKey", () => {
    const result = OpenRunPayloadSchema.safeParse({
      ...validPayload,
      idempotencyKey: "",
    });
    expect(result.success).toBe(false);
  });

  it("allows omitting every optional run field", () => {
    const result = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "key",
      run: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts null-valued metadata fields", () => {
    const result = OpenRunPayloadSchema.safeParse({
      idempotencyKey: "key",
      run: {
        ciProvider: null,
        branch: null,
        environment: null,
        commitSha: null,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("AppendResultsPayloadSchema", () => {
  it("accepts a single valid result", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [validTestResult],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty results array (must be min 1)", () => {
    const result = AppendResultsPayloadSchema.safeParse({ results: [] });
    expect(result.success).toBe(false);
  });

  it("accepts all valid test result statuses", () => {
    for (const status of ["passed", "failed", "flaky", "skipped", "timedout"]) {
      const result = AppendResultsPayloadSchema.safeParse({
        results: [{ ...validTestResult, status }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects negative durationMs", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [{ ...validTestResult, durationMs: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults retryCount to 0", () => {
    const { retryCount: _retryCount, ...withoutRetry } = validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutRetry],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].retryCount).toBe(0);
    }
  });

  it("defaults tags to empty array", () => {
    const { tags: _tags, ...withoutTags } = validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutTags],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].tags).toEqual([]);
    }
  });

  it("defaults annotations to empty array", () => {
    const { annotations: _annotations, ...withoutAnnotations } =
      validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutAnnotations],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].annotations).toEqual([]);
    }
  });

  it("rejects empty title", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [{ ...validTestResult, title: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional clientKey", () => {
    const { clientKey: _c, ...withoutKey } = validTestResult;
    const result = AppendResultsPayloadSchema.safeParse({
      results: [withoutKey],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty clientKey when provided", () => {
    const result = AppendResultsPayloadSchema.safeParse({
      results: [{ ...validTestResult, clientKey: "" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("CompleteRunPayloadSchema", () => {
  it("accepts terminal statuses", () => {
    for (const status of ["passed", "failed", "timedout", "interrupted"]) {
      const result = CompleteRunPayloadSchema.safeParse({
        status,
        durationMs: 1000,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects 'running' (non-terminal)", () => {
    const result = CompleteRunPayloadSchema.safeParse({
      status: "running",
      durationMs: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative durationMs", () => {
    const result = CompleteRunPayloadSchema.safeParse({
      status: "passed",
      durationMs: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("RegisterArtifactsPayloadSchema", () => {
  const validPayload = {
    runId: "run-123",
    artifacts: [
      {
        testResultId: "tr-1",
        type: "trace",
        name: "trace.zip",
        contentType: "application/zip",
        sizeBytes: 1048576,
      },
    ],
  };

  it("accepts a valid payload", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts all artifact types", () => {
    for (const type of ["trace", "screenshot", "video", "other"]) {
      const result = RegisterArtifactsPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [{ ...validPayload.artifacts[0], type }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid artifact type", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], type: "pdf" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty artifacts array", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      runId: "run-123",
      artifacts: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty runId", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      runId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative sizeBytes", () => {
    const result = RegisterArtifactsPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], sizeBytes: -1 }],
    });
    expect(result.success).toBe(false);
  });
});
