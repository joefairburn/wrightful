/**
 * Tenancy isolation under a real authenticated browser session.
 *
 * Setup: bootDashboard already seeded User A + team A + project A. This
 * spec creates a second identity (User B + team B + project B + API
 * key B) at suite-start time, then asserts:
 *
 *  1. UI: User A's session can't see team B's pages — NotFoundPage
 *     renders (HTTP 404 + "Not found" heading), no team-B data leaks.
 *  2. API: User A's API key can't ingest into a run owned by project B.
 */
import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./fixtures";
import { seedSecondUser } from "./helpers/second-user";

const SECOND_USER = {
  email: "second@wrightful.test",
  password: "second-second-password-1",
  name: "Second User",
  teamSlug: "second-team",
  teamName: "Second Team",
  projectSlug: "second-proj",
  projectName: "Second Proj",
};

// Only the seeded runId crosses test boundaries — User A needs a real
// team-B runId to attempt forbidden access. The second user / API key
// itself is consumed inside `beforeAll`.
let teamBRunId: string | undefined;

test.beforeAll(async ({ playwright, ctx }) => {
  const request: APIRequestContext = await playwright.request.newContext({
    baseURL: ctx.url,
  });
  try {
    const secondUser = await seedSecondUser(request, ctx.url, SECOND_USER);

    const openRunRes = await request.post("/api/runs", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secondUser.apiKey}`,
        "X-Wrightful-Version": "3",
      },
      data: {
        idempotencyKey: `xtenant-${Date.now()}`,
        run: { reporterVersion: "0.0.0", playwrightVersion: "0.0.0" },
      },
    });
    if (!openRunRes.ok()) {
      throw new Error(
        `team B openRun failed (${openRunRes.status()}): ${await openRunRes.text()}`,
      );
    }
    const body = (await openRunRes.json()) as { runId: string };
    teamBRunId = body.runId;
  } finally {
    await request.dispose();
  }
});

test.describe("UI isolation (User A's browser session)", () => {
  test("team B's project page renders NotFoundPage for User A", async ({
    page,
  }) => {
    const res = await page.goto(
      `/t/${SECOND_USER.teamSlug}/p/${SECOND_USER.projectSlug}`,
    );
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: /not found/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /all runs/i }),
    ).not.toBeVisible();
  });

  test("team B's run-detail URL renders NotFoundPage for User A", async ({
    page,
  }) => {
    if (!teamBRunId) throw new Error("teamBRunId not seeded");
    const res = await page.goto(
      `/t/${SECOND_USER.teamSlug}/p/${SECOND_USER.projectSlug}/runs/${teamBRunId}`,
    );
    expect(res?.status()).toBe(404);
    // NotFoundPage shell renders no labelled test list.
    await expect(page.getByRole("list", { name: /^Tests in / })).toHaveCount(0);
  });

  test("team B's settings page is not visible to User A", async ({ page }) => {
    const res = await page.goto(`/settings/teams/${SECOND_USER.teamSlug}`);
    expect(res?.status()).not.toBe(200);
  });
});

test.describe("API isolation (User A's API key)", () => {
  test("User A's API key can't append results to a team B run", async ({
    playwright,
    ctx,
  }) => {
    if (!teamBRunId) throw new Error("teamBRunId not seeded");
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const res = await request.post(`/api/runs/${teamBRunId}/results`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.apiKey}`, // User A's key
          "X-Wrightful-Version": "3",
        },
        data: {
          results: [
            {
              clientKey: "x",
              testId: "t1",
              title: "leak attempt",
              file: "x.spec.ts",
              status: "passed",
              durationMs: 1,
              retryCount: 0,
              tags: [],
              annotations: [],
              attempts: [
                {
                  attempt: 0,
                  status: "passed",
                  durationMs: 1,
                  errorMessage: null,
                  errorStack: null,
                },
              ],
            },
          ],
        },
      });
      expect(res.status()).toBe(404);
    } finally {
      await request.dispose();
    }
  });

  test("User A's API key can't register artifacts against a team B run", async ({
    playwright,
    ctx,
  }) => {
    if (!teamBRunId) throw new Error("teamBRunId not seeded");
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const res = await request.post("/api/artifacts/register", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.apiKey}`,
          "X-Wrightful-Version": "3",
        },
        data: {
          runId: teamBRunId,
          artifacts: [
            {
              testResultId: "tr-fake",
              type: "trace",
              name: "x.zip",
              contentType: "application/zip",
              sizeBytes: 1,
            },
          ],
        },
      });
      expect(res.status()).toBe(404);
    } finally {
      await request.dispose();
    }
  });
});
