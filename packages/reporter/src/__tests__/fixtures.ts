import type {
  FullConfig,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

// Minimal shims used across reporter tests. The reporter functions only read
// a handful of fields, so we construct just those rather than importing
// Playwright's full runtime.

export function makeTest(opts: {
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

export function makeResult(opts: {
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

export function makeConfig(rootDir: string | null = null): FullConfig {
  return {
    rootDir: rootDir ?? "",
    version: "1.59.0",
  } as unknown as FullConfig;
}

export function makeSuite(tests: TestCase[]): Suite {
  return {
    allTests: () => tests,
  } as unknown as Suite;
}
