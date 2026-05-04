/**
 * Tenancy isolation under a real authenticated browser session.
 *
 * Setup: bootDashboard already seeded User A + team A + project A. This
 * spec creates a second identity (User B + team B + project B + API
 * key B) at suite-start time, then asserts:
 *
 *  1. UI: User A's session can't see team B's pages — NotFoundPage
 *     renders (HTTP 404 + "Not found" heading), no team-B data leaks.
 *  2. API: User A's API key can't ingest into a run owned by project B
 *     (predicate enforced by `tenantScopeForApiKey` brand + the
 *     projectId WHERE on every read/write).
 *
 * The second user's API key is used in-test to mint a real run in
 * project B — the runId is needed for the API-side assertion (User A
 * trying to register an artifact against it).
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { readFixture } from "./helpers/fixture";
import { seedSecondUser, type SecondUserFixture } from "./helpers/second-user";

const fixture = readFixture();

const SECOND_USER = {
  email: "second@wrightful.test",
  password: "second-second-password-1",
  name: "Second User",
  teamSlug: "second-team",
  teamName: "Second Team",
  projectSlug: "second-proj",
  projectName: "Second Proj",
};

let secondUser: SecondUserFixture | undefined;
let teamBRunId: string | undefined;

test.beforeAll(async ({ playwright }) => {
  const request: APIRequestContext = await playwright.request.newContext({
    baseURL: fixture.url,
  });
  try {
    secondUser = await seedSecondUser(request, fixture.url, SECOND_USER);

    // Mint a real run in team B / project B using B's API key, so we
    // have a runId for the API-side cross-tenant assertion below.
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
    // Strong "no leak" check: the All Runs page chrome must NOT appear.
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
    // None of team B's test rows should leak through to User A's view.
    await expect(
      page.locator(`a[href*="/runs/${teamBRunId}/tests/"]`),
    ).toHaveCount(0);
  });

  test("team B's settings page is not visible to User A", async ({ page }) => {
    const res = await page.goto(`/settings/teams/${SECOND_USER.teamSlug}`);
    // Either the dashboard renders NotFoundPage (404) or redirects away —
    // both are acceptable; the failure mode is "User A sees team B's
    // settings", which is what we're guarding against.
    expect(res?.status()).not.toBe(200);
  });
});

test.describe("API isolation (User A's API key)", () => {
  test("User A's API key can't append results to a team B run", async ({
    playwright,
  }) => {
    if (!teamBRunId) throw new Error("teamBRunId not seeded");
    const request = await playwright.request.newContext({
      baseURL: fixture.url,
    });
    try {
      const res = await request.post(`/api/runs/${teamBRunId}/results`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey}`, // User A's key
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
      // 404 is the documented response for "run id not in this project".
      expect(res.status()).toBe(404);
    } finally {
      await request.dispose();
    }
  });

  test("User A's API key can't register artifacts against a team B run", async ({
    playwright,
  }) => {
    if (!teamBRunId) throw new Error("teamBRunId not seeded");
    const request = await playwright.request.newContext({
      baseURL: fixture.url,
    });
    try {
      const res = await request.post("/api/artifacts/register", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey}`,
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
