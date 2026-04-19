import { describe, it, expect } from "vitest";
import type { TestCase, TestResult } from "@playwright/test/reporter";
import { isTestDone, buildPayload, buildTestDescriptor } from "../index.js";

// Minimal shims. The reporter functions only read a handful of fields, so
// we construct just those rather than importing Playwright's full runtime.

function makeTest(opts: {
  id?: string;
  title?: string;
  file?: string;
  retries?: number;
  projectName?: string;
  outcome: "expected" | "unexpected" | "flaky" | "skipped";
  tags?: string[];
  annotations?: Array<{ type: string; description?: string }>;
}): TestCase {
  return {
    id: opts.id ?? "t1",
    title: opts.title ?? "my test",
    titlePath: () => [opts.title ?? "my test"],
    location: { file: opts.file ?? "a.spec.ts", line: 1, column: 1 },
    retries: opts.retries ?? 0,
    tags: opts.tags ?? [],
    annotations: opts.annotations ?? [],
    outcome: () => opts.outcome,
    parent: {
      project: () => ({ name: opts.projectName ?? "chromium" }),
    },
  } as unknown as TestCase;
}

function makeResult(opts: {
  status: TestResult["status"];
  duration: number;
  retry: number;
  errorMessage?: string;
  attachments?: TestResult["attachments"];
  workerIndex?: number;
}): TestResult {
  return {
    status: opts.status,
    duration: opts.duration,
    retry: opts.retry,
    errors: opts.errorMessage
      ? [{ message: opts.errorMessage, stack: "stack" }]
      : [],
    attachments: opts.attachments ?? [],
    workerIndex: opts.workerIndex ?? 0,
    startTime: new Date(),
  } as unknown as TestResult;
}

describe("isTestDone", () => {
  it("treats a passed attempt as done", () => {
    const t = makeTest({ retries: 2, outcome: "expected" });
    expect(
      isTestDone(t, makeResult({ status: "passed", duration: 10, retry: 0 })),
    ).toBe(true);
  });

  it("treats a skipped attempt as done", () => {
    const t = makeTest({ retries: 2, outcome: "skipped" });
    expect(
      isTestDone(t, makeResult({ status: "skipped", duration: 0, retry: 0 })),
    ).toBe(true);
  });

  it("treats an interrupted attempt as done", () => {
    const t = makeTest({ retries: 2, outcome: "unexpected" });
    expect(
      isTestDone(
        t,
        makeResult({ status: "interrupted", duration: 5, retry: 0 }),
      ),
    ).toBe(true);
  });

  it("waits for next attempt when failed with retries remaining", () => {
    const t = makeTest({ retries: 2, outcome: "unexpected" });
    expect(
      isTestDone(t, makeResult({ status: "failed", duration: 10, retry: 0 })),
    ).toBe(false);
    expect(
      isTestDone(t, makeResult({ status: "failed", duration: 10, retry: 1 })),
    ).toBe(false);
  });

  it("treats final failed attempt as done when retries exhausted", () => {
    const t = makeTest({ retries: 2, outcome: "unexpected" });
    expect(
      isTestDone(t, makeResult({ status: "failed", duration: 10, retry: 2 })),
    ).toBe(true);
  });

  it("single-run test (retries=0) is done on its only attempt", () => {
    const t = makeTest({ retries: 0, outcome: "expected" });
    expect(
      isTestDone(t, makeResult({ status: "passed", duration: 10, retry: 0 })),
    ).toBe(true);
  });
});

describe("buildPayload", () => {
  it("emits passed status with single attempt and retryCount=0", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 123, retry: 0 })],
    });
    expect(payload.status).toBe("passed");
    expect(payload.durationMs).toBe(123);
    expect(payload.retryCount).toBe(0);
    expect(payload.errorMessage).toBe(null);
  });

  it("aggregates flaky: failed-then-passed → one flaky row, summed duration", () => {
    const test = makeTest({ retries: 2, outcome: "flaky" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 200,
          retry: 0,
          errorMessage: "boom",
        }),
        makeResult({ status: "passed", duration: 150, retry: 1 }),
      ],
    });
    expect(payload.status).toBe("flaky");
    expect(payload.durationMs).toBe(350);
    expect(payload.retryCount).toBe(1);
    // errorMessage comes from the failing attempt, not the final pass.
    expect(payload.errorMessage).toBe("boom");
  });

  it("exhausted retries → failed with last attempt's error", () => {
    const test = makeTest({ retries: 2, outcome: "unexpected" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 100,
          retry: 0,
          errorMessage: "first",
        }),
        makeResult({
          status: "failed",
          duration: 100,
          retry: 1,
          errorMessage: "second",
        }),
        makeResult({
          status: "failed",
          duration: 100,
          retry: 2,
          errorMessage: "third",
        }),
      ],
    });
    expect(payload.status).toBe("failed");
    expect(payload.durationMs).toBe(300);
    expect(payload.retryCount).toBe(2);
    expect(payload.errorMessage).toBe("third");
  });

  it("maps timed-out unexpected to status=timedout", () => {
    const test = makeTest({ outcome: "unexpected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "timedOut", duration: 30000, retry: 0 })],
    });
    expect(payload.status).toBe("timedout");
  });

  it("maps skipped outcome to status=skipped", () => {
    const test = makeTest({ outcome: "skipped" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "skipped", duration: 0, retry: 0 })],
    });
    expect(payload.status).toBe("skipped");
  });

  it("passes through tags and annotations", () => {
    const test = makeTest({
      outcome: "expected",
      tags: ["smoke", "critical"],
      annotations: [{ type: "issue", description: "X-123" }],
    });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 10, retry: 0 })],
    });
    expect(payload.tags).toEqual(["smoke", "critical"]);
    expect(payload.annotations).toEqual([
      { type: "issue", description: "X-123" },
    ]);
  });

  it("clientKey matches testId (no :retry suffix)", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 10, retry: 0 })],
    });
    expect(payload.clientKey).toBe(payload.testId);
    expect(payload.clientKey).not.toMatch(/:/);
  });

  it("relativizes file path when rootDir is provided", () => {
    const test = makeTest({
      outcome: "expected",
      file: "/repo/packages/e2e/tests/demo.spec.ts",
    });
    const payload = buildPayload(
      {
        test,
        results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
      },
      "/repo/packages/e2e",
    );
    expect(payload.file).toBe("tests/demo.spec.ts");
  });

  it("passes file through unchanged when rootDir is null", () => {
    const test = makeTest({
      outcome: "expected",
      file: "/abs/path/tests/demo.spec.ts",
    });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
    });
    expect(payload.file).toBe("/abs/path/tests/demo.spec.ts");
  });
});

describe("buildTestDescriptor", () => {
  it("produces the same testId / file / title as buildPayload for the same test", () => {
    // Ensures the queue prefill at onBegin lands on exactly the row that
    // /results later UPSERTs — the server keys both by (runId, testId).
    const test = makeTest({
      outcome: "expected",
      title: "my test",
      file: "/repo/packages/e2e/tests/demo.spec.ts",
      projectName: "chromium",
    });
    const rootDir = "/repo/packages/e2e";
    const descriptor = buildTestDescriptor(test, rootDir);
    const payload = buildPayload(
      {
        test,
        results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
      },
      rootDir,
    );
    expect(descriptor.testId).toBe(payload.testId);
    expect(descriptor.file).toBe(payload.file);
    expect(descriptor.title).toBe(payload.title);
    expect(descriptor.projectName).toBe(payload.projectName);
  });
});
