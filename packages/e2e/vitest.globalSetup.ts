/**
 * Vitest globalSetup for the Wrightful e2e suite.
 *
 * Runs once before any test worker starts, and the corresponding teardown runs
 * once after all tests complete (even if setup or a test threw). Sets up the
 * full sandbox: build the CLI, migrate the local D1, clean + seed a test user
 * + team + project + API key, swap in fake R2 creds and a local Better Auth
 * secret in .dev.vars, spawn the dashboard dev server, and run the Playwright
 * demo suite to produce a realistic JSON report for the CLI-upload test.
 *
 * Values needed by tests (dashboard URL, API key, session cookie, slugs, file
 * paths) are passed via project.provide() and read with inject(). Teardown
 * restores .dev.vars and kills the dev server.
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
const API_KEY = "wrf_e2e_test_key_00000000";
const API_KEY_PREFIX = API_KEY.slice(0, 8);
const API_KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");

const TEAM_ID = "01E2ETEAM0000000000000000T";
const PROJECT_ID = "01E2EPROJ0000000000000000P";
const MEMBERSHIP_ID = "01E2EMEMB0000000000000000M";
const API_KEY_ID = "01E2EKEY000000000000000000";
const TEAM_SLUG = "e2e";
const PROJECT_SLUG = "demo";

const TEST_EMAIL = "e2e@wrightful.test";
const TEST_PASSWORD = "e2e-e2e-e2e-password";
const TEST_NAME = "E2E Tester";

// Fake secrets + vars scoped to the e2e dev server. BETTER_AUTH_SECRET is a
// fixed local value. WRIGHTFUL_PUBLIC_URL overrides the wrangler.jsonc var so
// Better Auth's origin check matches our ephemeral port. Artifact uploads hit
// the R2 binding — miniflare provisions an in-memory bucket from wrangler's
// r2_buckets block, so no S3 creds are needed.
const DEV_VARS =
  [
    `BETTER_AUTH_SECRET=e2e-local-only-not-a-secret-openssl-rand-base64-32ch`,
    `WRIGHTFUL_PUBLIC_URL=${DASHBOARD_URL}`,
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
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Server at ${url} did not start within ${maxAttempts}s`);
}

type SignUpResult = { userId: string; sessionCookie: string };

async function signUpTestUser(): Promise<SignUpResult> {
  const res = await fetch(`${DASHBOARD_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: DASHBOARD_URL,
    },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      name: TEST_NAME,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sign-up failed (${res.status}): ${body}`);
  }
  const body = (await res.json()) as { user: { id: string } };
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Sign-up did not return a session cookie");
  }
  // The Set-Cookie header may contain multiple attributes separated by `;`.
  // Just take the name=value pair for reuse in a `Cookie:` request header.
  const sessionCookie = setCookie.split(";")[0];
  return { userId: body.user.id, sessionCookie };
}

export async function setup(project: TestProject): Promise<void> {
  log("Step 1: Build CLI");
  run("pnpm build", { cwd: CLI_DIR });

  log("Step 2: Apply D1 migrations");
  run("pnpm db:migrate:local", { cwd: DASHBOARD_DIR });

  log("Step 3: Clean existing data");
  // Order matters — drop FK-dependent rows first.
  run(
    `npx wrangler d1 execute wrightful --local --command "DELETE FROM test_tags; DELETE FROM test_annotations; DELETE FROM artifacts; DELETE FROM test_results; DELETE FROM runs; DELETE FROM api_keys; DELETE FROM memberships; DELETE FROM session; DELETE FROM account; DELETE FROM verification; DELETE FROM user; DELETE FROM projects; DELETE FROM teams;"`,
    { cwd: DASHBOARD_DIR },
  );

  log("Step 4: Write fake R2 creds + BETTER_AUTH_SECRET to .dev.vars");
  if (existsSync(DEV_VARS_BACKUP_PATH)) {
    throw new Error(
      `Refusing to start: ${DEV_VARS_BACKUP_PATH} already exists. A previous e2e run likely crashed before teardown. Inspect it and restore/remove manually.`,
    );
  }
  if (existsSync(DEV_VARS_PATH)) {
    renameSync(DEV_VARS_PATH, DEV_VARS_BACKUP_PATH);
    log("  Existing .dev.vars backed up.");
  }
  devVarsBackedUp = true;
  writeFileSync(DEV_VARS_PATH, DEV_VARS, "utf8");

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

  log("Step 6: Create test user via Better Auth + seed team/project/key");
  const { userId, sessionCookie } = await signUpTestUser();
  const seedSql = [
    `INSERT INTO teams (id, slug, name, created_at) VALUES ('${TEAM_ID}', '${TEAM_SLUG}', 'E2E', unixepoch());`,
    `INSERT INTO projects (id, team_id, slug, name, created_at) VALUES ('${PROJECT_ID}', '${TEAM_ID}', '${PROJECT_SLUG}', 'Demo', unixepoch());`,
    `INSERT INTO memberships (id, user_id, team_id, role, created_at) VALUES ('${MEMBERSHIP_ID}', '${userId}', '${TEAM_ID}', 'owner', unixepoch());`,
    `INSERT INTO api_keys (id, project_id, label, key_hash, key_prefix, created_at) VALUES ('${API_KEY_ID}', '${PROJECT_ID}', 'e2e-test', '${API_KEY_HASH}', '${API_KEY_PREFIX}', unixepoch());`,
  ].join(" ");
  run(`npx wrangler d1 execute wrightful --local --command "${seedSql}"`, {
    cwd: DASHBOARD_DIR,
  });

  log("Step 7: Run Playwright tests to generate a real JSON report");
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
  project.provide("sessionCookie", sessionCookie);
  project.provide("teamSlug", TEAM_SLUG);
  project.provide("projectSlug", PROJECT_SLUG);
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
    sessionCookie: string;
    teamSlug: string;
    projectSlug: string;
  }
}
