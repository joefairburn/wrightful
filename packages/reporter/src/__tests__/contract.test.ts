import { describe, it, expect } from "vitest";
import {
  AppendResultsPayloadSchema,
  CompleteRunPayloadSchema,
  OpenRunPayloadSchema,
  RegisterArtifactsPayloadSchema,
} from "../../../dashboard/src/routes/api/schemas.js";
import { buildPayload, buildTestDescriptor } from "../index.js";
import type { ArtifactRegistration, TestResultPayload } from "../types.js";
import { makeResult, makeTest } from "./fixtures.js";

// This test is the canary against silent drift between the reporter's
// emitted payload shape (packages/reporter/src/index.ts) and the dashboard's
// Zod wire schemas (packages/dashboard/src/routes/api/schemas.ts). It builds
// payloads with the reporter's real `buildPayload` and parses them through
// the dashboard's schemas. Any divergence on either side breaks this test.

describe("reporter ↔ dashboard wire contract", () => {
  it("buildPayload output for a passing test parses through AppendResultsPayloadSchema", () => {
    const test = makeTest({ id: "t1", outcome: "expected", title: "passes" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 12, retry: 0 })],
    });

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a failed test parses through AppendResultsPayloadSchema", () => {
    const test = makeTest({ id: "t1", outcome: "unexpected", title: "fails" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 50,
          retry: 0,
          errorMessage: "boom",
        }),
      ],
    });

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a flaky test parses with all attempts present", () => {
    const test = makeTest({
      id: "t1",
      outcome: "flaky",
      title: "recovers on retry",
      retries: 2,
    });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 30,
          retry: 0,
          errorMessage: "first try",
        }),
        makeResult({ status: "passed", duration: 25, retry: 1 }),
      ],
    });

    expect(payload.status).toBe("flaky");
    expect(payload.retryCount).toBe(1);
    expect(payload.attempts).toHaveLength(2);

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a timed-out test maps Playwright 'timedOut' → wire 'timedout'", () => {
    const test = makeTest({ id: "t1", outcome: "unexpected", title: "slow" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "timedOut", duration: 30000, retry: 0 })],
    });

    expect(payload.status).toBe("timedout");
    expect(payload.attempts[0]?.status).toBe("timedout");

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a skipped test parses cleanly", () => {
    const test = makeTest({ id: "t1", outcome: "skipped", title: "skipped" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "skipped", duration: 0, retry: 0 })],
    });

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("batched payload (many tests) parses through AppendResultsPayloadSchema", () => {
    const payloads: TestResultPayload[] = [];
    for (let i = 0; i < 50; i++) {
      const test = makeTest({
        id: `t${i}`,
        outcome: i % 7 === 0 ? "unexpected" : "expected",
        title: `case ${i}`,
        file: `suite-${i % 5}.spec.ts`,
      });
      payloads.push(
        buildPayload({
          test,
          results: [
            makeResult({
              status: i % 7 === 0 ? "failed" : "passed",
              duration: i,
              retry: 0,
              errorMessage: i % 7 === 0 ? "x" : undefined,
            }),
          ],
        }),
      );
    }

    const parsed = AppendResultsPayloadSchema.safeParse({ results: payloads });
    expect(parsed.success).toBe(true);
  });

  it("planned-test descriptor parses through OpenRunPayloadSchema", () => {
    const tests = [
      makeTest({
        id: "t1",
        outcome: "expected",
        title: "a",
        file: "a.spec.ts",
      }),
      makeTest({
        id: "t2",
        outcome: "expected",
        title: "b",
        file: "b.spec.ts",
        projectName: "firefox",
      }),
    ];
    const plannedTests = tests.map((t) => buildTestDescriptor(t, null));

    const openPayload = {
      idempotencyKey: "deterministic-key",
      run: {
        ciProvider: null,
        ciBuildId: null,
        branch: null,
        environment: null,
        commitSha: null,
        commitMessage: null,
        prNumber: null,
        repo: null,
        actor: null,
        reporterVersion: "0.1.1",
        playwrightVersion: "1.59.0",
        expectedTotalTests: plannedTests.length,
        plannedTests,
      },
    };

    const parsed = OpenRunPayloadSchema.safeParse(openPayload);
    expect(parsed.success).toBe(true);
  });

  it("CompleteRunPayloadSchema accepts all reporter-emitted statuses", () => {
    for (const status of [
      "passed",
      "failed",
      "timedout",
      "interrupted",
    ] as const) {
      const parsed = CompleteRunPayloadSchema.safeParse({
        status,
        durationMs: 1234,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("RegisterArtifactsPayloadSchema accepts the reporter's ArtifactRegistration shape", () => {
    const registrations: ArtifactRegistration[] = [
      {
        testResultId: "tr_1",
        type: "trace",
        name: "trace.zip",
        contentType: "application/zip",
        sizeBytes: 1024,
        attempt: 0,
      },
      {
        testResultId: "tr_2",
        type: "screenshot",
        name: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 4096,
        attempt: 1,
      },
    ];

    const parsed = RegisterArtifactsPayloadSchema.safeParse({
      runId: "run_abc",
      artifacts: registrations,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty results batch (matches reporter's ≥1 invariant)", () => {
    const parsed = AppendResultsPayloadSchema.safeParse({ results: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed status (catches accidental enum drift)", () => {
    const parsed = AppendResultsPayloadSchema.safeParse({
      results: [
        {
          testId: "t1",
          title: "x",
          file: "a.spec.ts",
          status: "succeeded", // not a valid wire status
          durationMs: 0,
          retryCount: 0,
          attempts: [{ attempt: 0, status: "passed", durationMs: 0 }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
