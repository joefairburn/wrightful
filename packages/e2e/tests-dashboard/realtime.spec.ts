/**
 * Realtime UI updates via the SyncedStateServer DO.
 *
 * Flow:
 *   1. Open a fresh run via the public API.
 *   2. Navigate the browser to that run's detail page (auth'd).
 *   3. Append results via API.
 *   4. Assert the page DOM reflects the new state without reload —
 *      summary counters tick up, test row appears in the live list.
 */
import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./fixtures";

interface OpenRunResponse {
  runId: string;
}

async function openRun(
  request: APIRequestContext,
  apiKey: string,
): Promise<string> {
  const res = await request.post("/api/runs", {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Wrightful-Version": "3",
    },
    data: {
      idempotencyKey: `realtime-${Date.now()}-${Math.random()}`,
      run: { reporterVersion: "0.0.0", playwrightVersion: "0.0.0" },
    },
  });
  if (!res.ok()) {
    throw new Error(`openRun failed (${res.status()}): ${await res.text()}`);
  }
  const body = (await res.json()) as OpenRunResponse;
  return body.runId;
}

async function appendResults(
  request: APIRequestContext,
  apiKey: string,
  runId: string,
  results: Array<{
    testId: string;
    title: string;
    status: "passed" | "failed";
  }>,
): Promise<void> {
  const res = await request.post(`/api/runs/${runId}/results`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Wrightful-Version": "3",
    },
    data: {
      results: results.map((r) => ({
        clientKey: r.testId,
        testId: r.testId,
        title: r.title,
        file: "live.spec.ts",
        status: r.status,
        durationMs: 50,
        retryCount: 0,
        tags: [],
        annotations: [],
        attempts: [
          {
            attempt: 0,
            status: r.status,
            durationMs: 50,
            errorMessage: r.status === "failed" ? "boom" : null,
            errorStack: null,
          },
        ],
      })),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `appendResults failed (${res.status()}): ${await res.text()}`,
    );
  }
}

test.describe("Realtime UI updates (SyncedStateServer)", () => {
  test("a passing test appended via API appears live in the run detail page", async ({
    playwright,
    runDetailPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const runId = await openRun(request, ctx.apiKey);
      await runDetailPage.goto(runId);

      const uniqueTitle = `live-test-${Date.now()}`;
      await appendResults(request, ctx.apiKey, runId, [
        { testId: "live-1", title: uniqueTitle, status: "passed" },
      ]);

      await expect(runDetailPage.page.getByText(uniqueTitle)).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await request.dispose();
    }
  });

  test("summary counters update live as results stream in", async ({
    playwright,
    runDetailPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const runId = await openRun(request, ctx.apiKey);
      await runDetailPage.goto(runId);

      await appendResults(request, ctx.apiKey, runId, [
        { testId: "p-1", title: "p1", status: "passed" },
        { testId: "p-2", title: "p2", status: "passed" },
      ]);
      await appendResults(request, ctx.apiKey, runId, [
        { testId: "f-1", title: "f1", status: "failed" },
      ]);

      // The Failed summary tile is a `<button>` whose accessible name
      // joins its label and value: "Failed 1". Once a failure streams
      // in, the name picks up a non-zero digit.
      const failedTile = runDetailPage.page.getByRole("button", {
        name: /^Failed/,
      });
      await expect(failedTile).toContainText(/[1-9]/, { timeout: 5_000 });
    } finally {
      await request.dispose();
    }
  });
});
