import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FullResult } from "@playwright/test/reporter";
import WrightfulReporter from "../index.js";
import { makeConfig, makeResult, makeSuite, makeTest } from "./fixtures.js";

// Block CI auto-detection so the OpenRunPayload shape is deterministic
// regardless of where these tests run.
const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "GITHUB_RUN_ID",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Route requests to canned responses by URL substring. Returns unmatched
// responses as 200 {} so the reporter's graceful degradation can show through.
function makeFetch(
  handlers: Array<(url: string, init: RequestInit) => Response | undefined>,
) {
  return vi.fn(async (url: string, init: RequestInit) => {
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    return jsonResponse(200, {});
  });
}

describe("WrightfulReporter lifecycle", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const k of CI_ENV_VARS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
    delete process.env.WRIGHTFUL_URL;
    delete process.env.WRIGHTFUL_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // The reporter installs SIGTERM/SIGINT handlers at onBegin; remove them
    // so they don't fire (and call process.exit) when vitest tears the
    // worker process down.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drives openRun → appendResults → completeRun with correct wire shape", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = makeFetch([
      (url) => {
        if (url.endsWith("/api/runs")) {
          return jsonResponse(200, { runId: "run_abc" });
        }
        return undefined;
      },
      (url) => {
        if (url.includes("/results")) {
          // Match the two tests we'll stream: one passed, one flaky.
          return jsonResponse(200, {
            results: [
              { clientKey: "pass", testResultId: "tr_1" },
              { clientKey: "flaky", testResultId: "tr_2" },
              { clientKey: "fail", testResultId: "tr_3" },
            ],
          });
        }
        return undefined;
      },
      (url) => {
        if (url.endsWith("/complete")) {
          return jsonResponse(200, {});
        }
        return undefined;
      },
    ]);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const response = await fetchMock(url, init);
      calls.push({
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      return response;
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      // No-op: we assert on this later.
      () => true,
    );

    const passingTest = makeTest({
      id: "pass",
      outcome: "expected",
      title: "passes cleanly",
      file: "smoke.spec.ts",
    });
    const flakyTest = makeTest({
      id: "flaky",
      outcome: "flaky",
      title: "recovers on retry",
      file: "smoke.spec.ts",
      retries: 2,
    });
    const failingTest = makeTest({
      id: "fail",
      outcome: "unexpected",
      title: "fails hard",
      file: "smoke.spec.ts",
    });

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok-e2e",
      flushIntervalMs: 5,
    });

    reporter.onBegin(
      makeConfig(),
      makeSuite([passingTest, flakyTest, failingTest]),
    );

    reporter.onTestEnd(
      passingTest,
      makeResult({ status: "passed", duration: 10, retry: 0 }),
    );
    reporter.onTestEnd(
      flakyTest,
      makeResult({
        status: "failed",
        duration: 12,
        retry: 0,
        errorMessage: "flake",
      }),
    );
    reporter.onTestEnd(
      flakyTest,
      makeResult({ status: "passed", duration: 8, retry: 1 }),
    );
    reporter.onTestEnd(
      failingTest,
      makeResult({
        status: "failed",
        duration: 20,
        retry: 0,
        errorMessage: "bang",
      }),
    );

    await reporter.onEnd({
      status: "failed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const openRun = calls.find((c) => c.url.endsWith("/api/runs"));
    const appendCalls = calls.filter((c) => c.url.includes("/results"));
    const complete = calls.find((c) => c.url.endsWith("/complete"));

    expect(openRun).toBeDefined();
    const openBody = openRun!.body as {
      idempotencyKey: string;
      run: {
        expectedTotalTests: number;
        plannedTests: Array<{ title: string }>;
        reporterVersion: string;
        playwrightVersion: string;
      };
    };
    expect(openBody.idempotencyKey).toMatch(/.+/);
    expect(openBody.run.expectedTotalTests).toBe(3);
    expect(openBody.run.plannedTests).toHaveLength(3);
    expect(openBody.run.playwrightVersion).toBe("1.59.0");
    expect(openBody.run.reporterVersion).toMatch(/.+/);

    // Every emitted test should appear in some append call. The wire
    // `clientKey` is a SHA hash, not our test id — key lookups use `title`.
    type StreamedResult = {
      title: string;
      status: string;
      retryCount: number;
      errorMessage: string | null;
      attempts: Array<{ status: string }>;
    };
    const streamed = appendCalls.flatMap(
      (c) => (c.body as { results: StreamedResult[] }).results,
    );
    const byTitle = new Map(streamed.map((r) => [r.title, r]));
    expect(byTitle.get("passes cleanly")).toMatchObject({ status: "passed" });
    expect(byTitle.get("recovers on retry")).toMatchObject({
      status: "flaky",
      retryCount: 1,
    });
    expect(byTitle.get("fails hard")).toMatchObject({
      status: "failed",
      errorMessage: "bang",
    });
    const flakyPayload = byTitle.get("recovers on retry");
    expect(flakyPayload).toBeDefined();
    expect(flakyPayload!.attempts.map((a) => a.status)).toEqual([
      "failed",
      "passed",
    ]);

    expect(complete).toBeDefined();
    expect(complete!.body).toMatchObject({ status: "failed" });

    expect(stderrSpy).toHaveBeenCalled();
    // Summary line at end-of-suite includes the streamed count.
    const summaryLine = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("streamed"));
    expect(summaryLine).toMatch(/streamed 3\/3 test\(s\)/);
  });

  it("does not throw when the dashboard is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const t = makeTest({ id: "pass", outcome: "expected" });
    const reporter = new WrightfulReporter({
      url: "http://unreachable.example",
      token: "tok",
      flushIntervalMs: 5,
    });

    reporter.onBegin(makeConfig(), makeSuite([t]));
    reporter.onTestEnd(
      t,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );

    // Must not reject.
    await expect(
      reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult),
    ).resolves.toBeUndefined();
  });

  it("disables streaming quietly when URL or token is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const reporter = new WrightfulReporter({ url: "http://dash.example" });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    expect(fetchMock).not.toHaveBeenCalled();
    const msg = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("streaming disabled"));
    expect(msg).toBeDefined();
  });
});
