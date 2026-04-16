/**
 * Vitest globalSetup for the Wrightful e2e suite.
 *
 * Runs once before any test worker starts, and the corresponding teardown runs
 * once after all tests complete (even if setup or a test threw). Sets up the
 * full sandbox: build the CLI, migrate the local D1, clean + seed an API key,
 * swap in fake R2 creds, spawn the dashboard dev server, and run the Playwright
 * demo suite to produce a realistic JSON report for the CLI-upload test.
 *
 * Values needed by tests (dashboard URL, API key, file paths) are passed via
 * project.provide() and read with inject(). Teardown restores .dev.vars and
 * kills the dev server.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DASHBOARD_DIR = resolve(ROOT, "packages/dashboard");
const CLI_DIR = resolve(ROOT, "packages/cli");
const E2E_DIR = resolve(ROOT, "packages/e2e");
const CLI_PATH = resolve(CLI_DIR, "dist/index.js");
const REPORT_PATH = resolve(E2E_DIR, "playwright-report.json");
const DEV_VARS_PATH = resolve(DASHBOARD_DIR, ".dev.vars");
const DEV_VARS_BACKUP_PATH = resolve(DASHBOARD_DIR, ".dev.vars.e2e-backup");

const PORT = 5188;
const DASHBOARD_URL = `http://localhost:${PORT}`;
const API_KEY = "grn_e2e_test_key_00000000";
const API_KEY_PREFIX = API_KEY.slice(0, 8);
const API_KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");

// Fake R2 creds used only for presign-URL signing during e2e. Signatures
// computed with these will not authenticate against real R2, but that's fine —
// the e2e test only asserts the endpoint returns 201 with a well-formed
// response; it does not attempt to PUT to the returned URL.
const FAKE_R2_VARS =
  [
    `R2_ACCOUNT_ID=e2e-fake-account`,
    `R2_BUCKET_NAME=wrightful-artifacts`,
    `R2_ACCESS_KEY_ID=AKIAE2EFAKE`,
    `R2_SECRET_ACCESS_KEY=e2e-fake-secret`,
  ].join("\n") + "\n";

// Module-level state so teardown() can always clean up, even if setup() throws
// partway through.
let devServer: ChildProcess | undefined;
let devVarsBackedUp = false;

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

function run(cmd: string, opts: { cwd?: string } = {}): string {
  return execSync(cmd, { stdio: "pipe", ...opts })
    .toString()
    .trim();
}

async function waitForServer(url: string, maxAttempts = 40): Promise<void> {
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

export async function setup(project: TestProject): Promise<void> {
  log("Step 1: Build CLI");
  run("pnpm build", { cwd: CLI_DIR });

  log("Step 2: Apply D1 migrations");
  run("pnpm db:migrate:local", { cwd: DASHBOARD_DIR });

  log("Step 3: Clean existing data and seed API key");
  run(
    `npx wrangler d1 execute wrightful --local --command "DELETE FROM test_tags; DELETE FROM test_annotations; DELETE FROM artifacts; DELETE FROM test_results; DELETE FROM runs;"`,
    { cwd: DASHBOARD_DIR },
  );
  const seedSql = `INSERT OR IGNORE INTO api_keys (id, label, key_hash, key_prefix, created_at) VALUES ('01TESTKEY000000000000000000', 'e2e-test', '${API_KEY_HASH}', '${API_KEY_PREFIX}', ${Math.floor(Date.now() / 1000)});`;
  run(`npx wrangler d1 execute wrightful --local --command "${seedSql}"`, {
    cwd: DASHBOARD_DIR,
  });

  log("Step 4: Write fake R2 creds to .dev.vars for presign signing");
  // Refuse to proceed if a backup from a prior crashed run is still around —
  // otherwise the next renameSync would overwrite the real creds sitting in
  // the backup path with the fake creds from the last run.
  if (existsSync(DEV_VARS_BACKUP_PATH)) {
    throw new Error(
      `Refusing to start: ${DEV_VARS_BACKUP_PATH} already exists. A previous e2e run likely crashed before teardown. Inspect it and restore/remove manually.`,
    );
  }
  if (existsSync(DEV_VARS_PATH)) {
    renameSync(DEV_VARS_PATH, DEV_VARS_BACKUP_PATH);
    log("  Existing .dev.vars backed up.");
  }
  // Flip the flag before the write so teardown restores/cleans up even if
  // writeFileSync throws mid-way and leaves a partial file behind.
  devVarsBackedUp = true;
  writeFileSync(DEV_VARS_PATH, FAKE_R2_VARS, "utf8");

  log("Step 5: Start dashboard dev server");
  devServer = spawn("npx", ["vite", "dev", "--port", String(PORT)], {
    cwd: DASHBOARD_DIR,
    stdio: "pipe",
    env: { ...process.env },
  });
  let serverLog = "";
  devServer.stdout?.on("data", (d) => (serverLog += d.toString()));
  devServer.stderr?.on("data", (d) => (serverLog += d.toString()));
  try {
    await waitForServer(DASHBOARD_URL);
  } catch (err) {
    console.error(
      `\n[e2e] Dev server failed to start. Output so far:\n${serverLog}`,
    );
    throw err;
  }
  log("  Dashboard ready.");

  log("Step 6: Run Playwright tests to generate a real JSON report");
  if (existsSync(REPORT_PATH)) unlinkSync(REPORT_PATH);
  try {
    run("npx playwright test", { cwd: E2E_DIR });
  } catch {
    // Some demo tests may fail — that's fine, we only need the JSON report.
  }
  if (!existsSync(REPORT_PATH)) {
    throw new Error("Playwright did not generate a JSON report");
  }

  project.provide("dashboardUrl", DASHBOARD_URL);
  project.provide("apiKey", API_KEY);
  project.provide("reportPath", REPORT_PATH);
  project.provide("cliPath", CLI_PATH);
  project.provide("dashboardDir", DASHBOARD_DIR);
}

export function teardown(): void {
  if (devServer) {
    devServer.kill("SIGTERM");
    devServer = undefined;
  }
  if (devVarsBackedUp) {
    try {
      if (existsSync(DEV_VARS_BACKUP_PATH)) {
        if (existsSync(DEV_VARS_PATH)) unlinkSync(DEV_VARS_PATH);
        renameSync(DEV_VARS_BACKUP_PATH, DEV_VARS_PATH);
      } else if (existsSync(DEV_VARS_PATH)) {
        unlinkSync(DEV_VARS_PATH);
      }
      devVarsBackedUp = false;
    } catch (err) {
      console.error(`[e2e] Failed to restore .dev.vars:`, err);
    }
  }
}

declare module "vitest" {
  export interface ProvidedContext {
    dashboardUrl: string;
    apiKey: string;
    reportPath: string;
    cliPath: string;
    dashboardDir: string;
  }
}
