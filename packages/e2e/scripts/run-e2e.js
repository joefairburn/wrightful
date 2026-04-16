#!/usr/bin/env node

/**
 * E2E test runner for Greenroom.
 *
 * Tests the full product flow against a real Playwright JSON report:
 *
 * 1. Builds the CLI
 * 2. Applies D1 migrations, cleans data, seeds API key
 * 3. Starts the dashboard dev server
 * 4. Runs real Playwright tests → generates a real JSON report
 * 5. Uploads the report via CLI
 * 6. Verifies auth, validation, versioning, data rendering
 * 7. Tears down
 *
 * Usage: node scripts/run-e2e.js
 *   or:  pnpm --filter @greenroom/e2e test
 */

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DASHBOARD_DIR = resolve(ROOT, "packages/dashboard");
const CLI_DIR = resolve(ROOT, "packages/cli");
const E2E_DIR = resolve(ROOT, "packages/e2e");
const REPORT_PATH = resolve(E2E_DIR, "playwright-report.json");

const PORT = 5188;
const DASHBOARD_URL = `http://localhost:${PORT}`;
const API_KEY = "grn_e2e_test_key_00000000";
const API_KEY_PREFIX = API_KEY.slice(0, 8);
const API_KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");

let devServer;
let passed = 0;
let failed = 0;

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

function assert(condition, msg) {
  if (condition) {
    passed++;
    log(`  PASS: ${msg}`);
  } else {
    failed++;
    log(`  FAIL: ${msg}`);
  }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", ...opts }).toString().trim();
}

async function waitForServer(url, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Server at ${url} did not start within ${maxAttempts}s`);
}

async function main() {
  try {
    // --- Setup ---

    log("Step 1: Build CLI");
    run("pnpm build", { cwd: CLI_DIR });
    log("  CLI built.");

    log("Step 2: Apply D1 migrations");
    run("pnpm db:migrate:local", { cwd: DASHBOARD_DIR });
    log("  Migrations applied.");

    log("Step 3: Clean existing data and seed API key");
    run(
      `npx wrangler d1 execute greenroom --local --command "DELETE FROM test_tags; DELETE FROM test_annotations; DELETE FROM artifacts; DELETE FROM test_results; DELETE FROM runs;"`,
      { cwd: DASHBOARD_DIR },
    );
    log("  Existing data cleared.");
    const seedSql = `INSERT OR IGNORE INTO api_keys (id, label, key_hash, key_prefix, created_at) VALUES ('01TESTKEY000000000000000000', 'e2e-test', '${API_KEY_HASH}', '${API_KEY_PREFIX}', ${Math.floor(Date.now() / 1000)});`;
    run(`npx wrangler d1 execute greenroom --local --command "${seedSql}"`, {
      cwd: DASHBOARD_DIR,
    });
    log("  API key seeded.");

    log("Step 4: Start dashboard dev server");
    devServer = spawn("npx", ["vite", "dev", "--port", String(PORT)], {
      cwd: DASHBOARD_DIR,
      stdio: "pipe",
      env: { ...process.env },
    });

    let serverLog = "";
    devServer.stdout.on("data", (d) => (serverLog += d.toString()));
    devServer.stderr.on("data", (d) => (serverLog += d.toString()));

    await waitForServer(DASHBOARD_URL);
    log("  Dashboard ready.");

    log("Step 5: Run Playwright tests to generate a real JSON report");
    if (existsSync(REPORT_PATH)) unlinkSync(REPORT_PATH);
    try {
      run("npx playwright test", { cwd: E2E_DIR });
      log("  Playwright tests passed.");
    } catch {
      // Some tests may fail — that's fine, we just need the JSON report
      log("  Playwright tests finished (some may have failed — that's ok).");
    }
    assert(existsSync(REPORT_PATH), "Playwright generated a JSON report");

    // --- Tests ---

    // Test 1: Dashboard shows empty state before upload
    log("\nTest 1: Empty state");
    {
      const res = await fetch(DASHBOARD_URL);
      const html = await res.text();
      assert(res.ok, "Dashboard returns 200");
      assert(
        html.includes("No test runs yet"),
        "Shows 'No test runs yet' when empty",
      );
    }

    // Test 2: Auth rejection
    log("\nTest 2: Auth rejection");
    {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      assert(res.status === 401, "Returns 401 without auth token");
    }

    // Test 3: Auth with bad key
    log("\nTest 3: Bad API key");
    {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer grn_bad_key_99999999",
        },
        body: JSON.stringify({ test: true }),
      });
      assert(res.status === 401, "Returns 401 with invalid key");
    }

    // Test 4: Validation error
    log("\nTest 4: Validation error");
    {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Greenroom-Version": "1",
        },
        body: JSON.stringify({ bad: "payload" }),
      });
      assert(res.status === 400, "Returns 400 for invalid payload");
      const body = await res.json();
      assert(body.error === "Validation failed", "Error message is correct");
    }

    // Test 5: Version negotiation
    log("\nTest 5: Version negotiation");
    {
      const res = await fetch(`${DASHBOARD_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Greenroom-Version": "99",
        },
        body: JSON.stringify({}),
      });
      assert(res.status === 409, "Returns 409 for future version");
    }

    // Test 6: CLI upload with real Playwright report
    log("\nTest 6: CLI upload (real Playwright report)");
    {
      const output = run(
        `node ${resolve(CLI_DIR, "dist/index.js")} upload ${REPORT_PATH} --url ${DASHBOARD_URL} --token ${API_KEY}`,
      );
      assert(output.includes("Upload complete"), "CLI reports success");
      assert(output.includes("/runs/"), "CLI returns run URL");

      // Extract test count from output — should match whatever Playwright ran
      const countMatch = output.match(/(\d+) tests/);
      if (countMatch) {
        log(`  Uploaded ${countMatch[1]} tests from real Playwright report.`);
      }
    }

    // Test 7: Data visible in dashboard
    log("\nTest 7: Dashboard shows run data");
    {
      const res = await fetch(DASHBOARD_URL);
      const html = await res.text();
      assert(!html.includes("No test runs yet"), "Empty state is gone");
      assert(html.includes("/runs/"), "Has link to run detail");
    }

    // Test 8: Run detail page renders test results
    log("\nTest 8: Run detail page");
    {
      const res = await fetch(DASHBOARD_URL);
      const html = await res.text();
      const match = html.match(/\/runs\/([\w]+)/);
      assert(match !== null, "Can extract run ID from dashboard");

      if (match) {
        const detailRes = await fetch(`${DASHBOARD_URL}/runs/${match[1]}`);
        const detailHtml = await detailRes.text();
        assert(detailRes.ok, "Run detail returns 200");
        // The demo tests hit playwright.dev — look for "demo" or "spec" in the rendered output
        assert(
          detailHtml.includes("demo") ||
            detailHtml.includes("spec") ||
            detailHtml.includes("Test Results"),
          "Run detail renders test result data",
        );
      }
    }

    // Test 9: Artifacts presign endpoint (not yet implemented)
    log("\nTest 9: Artifacts presign");
    {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/presign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Greenroom-Version": "1",
        },
        body: JSON.stringify({}),
      });
      assert(res.status === 501, "Presign endpoint returns 501 Not Implemented");
    }

    // --- Summary ---
    console.log(`\n${"=".repeat(50)}`);
    console.log(`[e2e] ${passed} passed, ${failed} failed`);
    console.log(`${"=".repeat(50)}`);
  } catch (err) {
    console.error(`\n[e2e] FATAL: ${err.message}`);
    failed++;
  } finally {
    if (devServer) {
      devServer.kill("SIGTERM");
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
