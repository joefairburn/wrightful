/**
 * E2E assertions that run against a live dashboard booted by Vitest's
 * globalSetup (packages/e2e/vitest.globalSetup.ts). Connection details are
 * passed in via inject() — see the ProvidedContext augmentation in
 * vitest.globalSetup.ts for the full set of keys.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import { beforeAll, describe, expect, inject, it } from "vitest";

const DASHBOARD_URL = inject("dashboardUrl");
const API_KEY = inject("apiKey");
const REPORT_PATH = inject("reportPath");
const CLI_PATH = inject("cliPath");
const DASHBOARD_DIR = inject("dashboardDir");
const SESSION_COOKIE = inject("sessionCookie");
const TEAM_SLUG = inject("teamSlug");
const PROJECT_SLUG = inject("projectSlug");

const PROJECT_URL = `${DASHBOARD_URL}/t/${TEAM_SLUG}/p/${PROJECT_SLUG}`;

function sh(cmd: string, opts: { cwd?: string } = {}): string {
  return execSync(cmd, { stdio: "pipe", ...opts })
    .toString()
    .trim();
}

function fetchAuthed(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", SESSION_COOKIE);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

describe("Wrightful E2E", () => {
  beforeAll(() => {
    if (!existsSync(REPORT_PATH)) {
      throw new Error(`Playwright report not found at ${REPORT_PATH}`);
    }
  });

  describe("Dashboard auth gate", () => {
    it("redirects unauthenticated / to /login", async () => {
      const res = await fetch(DASHBOARD_URL, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("returns 200 with 'No test runs yet' on the scoped project page", async () => {
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("No test runs yet");
    });
  });

  describe("Ingest auth + validation", () => {
    it("rejects requests without an auth token (401)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects requests with a bad API key (401)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer grn_bad_key_99999999",
        },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects invalid payloads (400) with a validation message", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "1",
        },
        body: JSON.stringify({ bad: "payload" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Validation failed");
    });

    it("rejects unknown protocol versions (409)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "99",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("CLI upload → dashboard render", () => {
    it("uploads a real Playwright report via the CLI", () => {
      const output = sh(
        `node ${CLI_PATH} upload ${REPORT_PATH} --url ${DASHBOARD_URL} --token ${API_KEY}`,
      );
      expect(output).toContain("Upload complete");
      // CLI prints the scoped runUrl the server returned.
      expect(output).toContain(`/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/`);
    });

    it("renders the run on the scoped project runs page", async () => {
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).not.toContain("No test runs yet");
      expect(html).toMatch(
        new RegExp(`/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/`),
      );
    });

    it("renders the run detail page with test result data", async () => {
      const indexHtml = await (await fetchAuthed(PROJECT_URL)).text();
      const runHrefRe = new RegExp(
        `/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/([\\w]+)`,
      );
      const match = indexHtml.match(runHrefRe);
      expect(match).not.toBeNull();
      const runId = match![1];

      const detailRes = await fetchAuthed(`${PROJECT_URL}/runs/${runId}`);
      const detailHtml = await detailRes.text();
      expect(detailRes.status).toBe(200);
      expect(
        detailHtml.includes("demo") ||
          detailHtml.includes("spec") ||
          detailHtml.includes("Test Results"),
      ).toBe(true);
    });
  });

  describe("Artifacts presign", () => {
    // Read once and share across the suite — re-running `wrangler d1 execute`
    // per test sometimes flakes the dev server connection (ECONNRESET).
    let runId: string;
    let testResultId: string;
    beforeAll(() => {
      const seeded = readSeededTestResult();
      runId = seeded.runId;
      testResultId = seeded.testResultId;
    });

    it("rejects an invalid presign payload (400)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/presign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "1",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("signs a URL and eagerly inserts an artifact row", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/presign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "1",
        },
        body: JSON.stringify({
          runId,
          artifacts: [
            {
              testResultId,
              type: "trace",
              name: "trace.zip",
              contentType: "application/zip",
              sizeBytes: 1024,
            },
          ],
        }),
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        uploads?: Array<{
          url?: string;
          r2Key?: string;
          artifactId?: string;
          expiresAt?: string;
        }>;
      };
      expect(body.uploads).toHaveLength(1);

      const upload = body.uploads![0];
      expect(upload.url).toMatch(/^https:\/\/.*X-Amz-Signature=/);
      expect(upload.r2Key).toMatch(
        new RegExp(`^runs/${runId}/${testResultId}/.+/trace\\.zip$`),
      );
      expect(upload.artifactId).toBeTruthy();
      expect(Number.isNaN(Date.parse(upload.expiresAt ?? ""))).toBe(false);

      const countJson = sh(
        `npx wrangler d1 execute wrightful --local --json --command "SELECT COUNT(*) AS n FROM artifacts WHERE test_result_id = '${testResultId}';"`,
        { cwd: DASHBOARD_DIR },
      );
      const count = JSON.parse(countJson)[0]?.results?.[0]?.n;
      expect(count).toBe(1);
    });

    it("rejects a run that doesn't belong to the caller's project (404)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/presign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "1",
        },
        body: JSON.stringify({
          runId: "nonexistent-run",
          artifacts: [
            {
              testResultId,
              type: "trace",
              name: "trace.zip",
              contentType: "application/zip",
              sizeBytes: 1024,
            },
          ],
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});

function readSeededTestResult(): { runId: string; testResultId: string } {
  const rowJson = sh(
    `npx wrangler d1 execute wrightful --local --json --command "SELECT tr.id AS test_result_id, tr.run_id AS run_id FROM test_results tr LIMIT 1;"`,
    { cwd: DASHBOARD_DIR },
  );
  const rows = JSON.parse(rowJson)[0]?.results ?? [];
  if (rows.length !== 1) {
    throw new Error(
      "Expected exactly one seeded test_result in D1 — did the CLI upload test run first?",
    );
  }
  return {
    runId: rows[0].run_id as string,
    testResultId: rows[0].test_result_id as string,
  };
}
