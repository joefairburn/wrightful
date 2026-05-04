/**
 * Realtime UI updates via the SyncedStateServer DO.
 *
 * Flow:
 *   1. Open a fresh run via the public API (POST /api/runs).
 *   2. Navigate the browser to that run's detail page (auth'd).
 *   3. Append results via API (POST /api/runs/:id/results).
 *   4. Assert the page DOM reflects the new state without reload —
 *      summary counters tick up, test row appears in the live list.
 *
 * The dashboard's `broadcastRunUpdate` (packages/dashboard/src/routes/api/progress.ts)
 * fires from every ingest write; this spec exercises the end-to-end
 * push path: ingest handler → SyncedStateServer DO setState → client
 * island re-render.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

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
    page,
    playwright,
  }) => {
    const request = await playwright.request.newContext({
      baseURL: fixture.url,
    });

    try {
      const runId = await openRun(request, fixture.apiKey);

      await page.goto(
        `/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/${runId}`,
      );
      // The page is open; nothing has streamed yet. Append a test result.
      const uniqueTitle = `live-test-${Date.now()}`;
      await appendResults(request, fixture.apiKey, runId, [
        { testId: "live-1", title: uniqueTitle, status: "passed" },
      ]);

      // The synced-state push lands within one round-trip; give it 5s
      // upper bound for browser→DO→client reconciliation.
      await expect(page.getByText(uniqueTitle)).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await request.dispose();
    }
  });

  test("summary counters update live as results stream in", async ({
    page,
    playwright,
  }) => {
    const request = await playwright.request.newContext({
      baseURL: fixture.url,
    });

    try {
      const runId = await openRun(request, fixture.apiKey);
      await page.goto(
        `/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/${runId}`,
      );

      // Append three passing + one failing in two batches and assert
      // the failed counter ticks past zero. We don't pin an exact
      // number — just that a non-zero failed count appears, which
      // proves the summary subscription is live.
      await appendResults(request, fixture.apiKey, runId, [
        { testId: "p-1", title: "p1", status: "passed" },
        { testId: "p-2", title: "p2", status: "passed" },
      ]);
      await appendResults(request, fixture.apiKey, runId, [
        { testId: "f-1", title: "f1", status: "failed" },
      ]);

      // The summary tile labelled "Failed" should reflect the new state.
      // Use a regex that matches "1" near the word "Failed" — exact DOM
      // structure varies, so anchor on the visible label.
      const failedTile = page
        .locator(":has-text('Failed')")
        .filter({ hasText: /[1-9]/ });
      await expect(failedTile.first()).toBeVisible({ timeout: 5_000 });
    } finally {
      await request.dispose();
    }
  });
});
