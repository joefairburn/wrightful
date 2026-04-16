import { describe, it, expect } from "vitest";
import {
  IngestPayloadSchema,
  PresignPayloadSchema,
} from "../routes/api/schemas";

describe("IngestPayloadSchema", () => {
  const validPayload = {
    idempotencyKey: "test-key-1",
    run: {
      ciProvider: "github-actions",
      ciBuildId: "12345",
      branch: "main",
      commitSha: "abc123",
      commitMessage: "fix things",
      prNumber: 42,
      repo: "org/repo",
      shardIndex: 0,
      shardTotal: 4,
      status: "passed",
      durationMs: 10000,
      reporterVersion: "0.1.0",
      playwrightVersion: "1.50.0",
    },
    results: [
      {
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
      },
    ],
  };

  it("accepts a valid payload", () => {
    const result = IngestPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects empty idempotencyKey", () => {
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      idempotencyKey: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid run status", () => {
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      run: { ...validPayload.run, status: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid test result statuses", () => {
    for (const status of ["passed", "failed", "flaky", "skipped", "timedout"]) {
      const result = IngestPayloadSchema.safeParse({
        ...validPayload,
        results: [{ ...validPayload.results[0], status }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects negative durationMs", () => {
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      run: { ...validPayload.run, durationMs: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("defaults retryCount to 0", () => {
    const { retryCount: _retryCount, ...withoutRetry } =
      validPayload.results[0];
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      results: [withoutRetry],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].retryCount).toBe(0);
    }
  });

  it("defaults tags to empty array", () => {
    const { tags: _tags, ...withoutTags } = validPayload.results[0];
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      results: [withoutTags],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].tags).toEqual([]);
    }
  });

  it("defaults annotations to empty array", () => {
    const { annotations: _annotations, ...withoutAnnotations } =
      validPayload.results[0];
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      results: [withoutAnnotations],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0].annotations).toEqual([]);
    }
  });

  it("accepts empty results array", () => {
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      results: [],
    });
    expect(result.success).toBe(true);
  });

  it("allows nullable optional fields", () => {
    const result = IngestPayloadSchema.safeParse({
      idempotencyKey: "key",
      run: {
        status: "passed",
        durationMs: 100,
      },
      results: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing run.status", () => {
    const result = IngestPayloadSchema.safeParse({
      idempotencyKey: "key",
      run: { durationMs: 100 },
      results: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing test result title", () => {
    const result = IngestPayloadSchema.safeParse({
      ...validPayload,
      results: [{ ...validPayload.results[0], title: "" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PresignPayloadSchema", () => {
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
    const result = PresignPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts all artifact types", () => {
    for (const type of ["trace", "screenshot", "video", "other"]) {
      const result = PresignPayloadSchema.safeParse({
        ...validPayload,
        artifacts: [{ ...validPayload.artifacts[0], type }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid artifact type", () => {
    const result = PresignPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], type: "pdf" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty artifacts array", () => {
    const result = PresignPayloadSchema.safeParse({
      runId: "run-123",
      artifacts: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty runId", () => {
    const result = PresignPayloadSchema.safeParse({
      ...validPayload,
      runId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative sizeBytes", () => {
    const result = PresignPayloadSchema.safeParse({
      ...validPayload,
      artifacts: [{ ...validPayload.artifacts[0], sizeBytes: -1 }],
    });
    expect(result.success).toBe(false);
  });
});
