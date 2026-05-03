/**
 * Vitest globalSetup for the Wrightful e2e suite.
 *
 * Runs once before any test worker starts, and the corresponding teardown runs
 * once after all tests complete (even if setup or a test threw). Sets up the
 * full sandbox: build the CLI, wipe stale local DO state, swap in fake R2
 * creds and a local Better Auth secret in .dev.vars, spawn the dashboard dev
 * server, sign up a test user + create team + project + API key over HTTP
 * (ControlDO bindings only exist inside the worker, so seeding goes through
 * the running dashboard the same way `scripts/seed-demo.mjs` does), then run
 * the Playwright demo suite to produce a realistic JSON report for the
 * CLI-upload test.
 *
 * Values needed by tests (dashboard URL, API key, session cookie, slugs, file
 * paths) are passed via project.provide() and read with inject(). Teardown
 * restores .dev.vars and kills the dev server.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  existsSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DASHBOARD_DIR = resolve(ROOT, "packages/dashboard");
const REPORTER_DIR = resolve(ROOT, "packages/reporter");
const E2E_DIR = resolve(ROOT, "packages/e2e");
const REPORT_PATH = resolve(E2E_DIR, "playwright-report.json");
const DEV_VARS_PATH = resolve(DASHBOARD_DIR, ".dev.vars");
const DEV_VARS_BACKUP_PATH = resolve(DASHBOARD_DIR, ".dev.vars.e2e-backup");

const PORT = 5188;
const DASHBOARD_URL = `http://localhost:${PORT}`;
const BETTER_AUTH_SECRET =
  "e2e-local-only-not-a-secret-openssl-rand-base64-32ch";

const TEAM_NAME = "E2E";
const TEAM_SLUG = "e2e";
const PROJECT_NAME = "Demo";
const PROJECT_SLUG = "demo";

const TEST_EMAIL = "e2e@wrightful.test";
const TEST_PASSWORD = "e2e-e2e-e2e-password";
const TEST_NAME = "E2E Tester";

const REVEAL_COOKIE = "wrightful_reveal_key";

// Fake secrets + vars scoped to the e2e dev server. BETTER_AUTH_SECRET is a
// fixed local value. WRIGHTFUL_PUBLIC_URL overrides the wrangler.jsonc var so
// Better Auth's origin check matches our ephemeral port. Artifact uploads hit
// the R2 binding — miniflare provisions an in-memory bucket from wrangler's
// r2_buckets block, so no S3 creds are needed.
const DEV_VARS =
  [
    `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}`,
    `WRIGHTFUL_PUBLIC_URL=${DASHBOARD_URL}`,
    // Email/password signup is gated behind this flag in production; the e2e
    // suite provisions its test user via /api/auth/sign-up/email so we
    // explicitly opt in here.
    `ALLOW_OPEN_SIGNUP=1`,
  ].join("\n") + "\n";

// Module-level state so teardown() can always clean up, even if setup() throws
// partway through.
let devServer: ChildProcess | undefined;
let devVarsBackedUp = false;

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

function run(
  cmd: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execSync(cmd, { stdio: "pipe", ...opts })
    .toString()
    .trim();
}

async function waitForServer(url: string, maxAttempts = 90): Promise<void> {
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

/** Get cookie name=value pairs from a response, suitable for a Cookie header. */
function readSetCookies(res: Response): string[] {
  return res.headers.getSetCookie().map((raw) => raw.split(";")[0]);
}

type RequestOpts = {
  cookies?: string[];
  json?: unknown;
  form?: Record<string, string>;
};

/**
 * HTTP helper: never follows redirects (we read Location + Set-Cookie from
 * 302s ourselves), always sends Origin (Better Auth's CSRF guard 403s
 * `MISSING_OR_NULL_ORIGIN` otherwise).
 */
async function request(
  method: string,
  path: string,
  opts: RequestOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Origin: DASHBOARD_URL,
  };
  if (opts.cookies && opts.cookies.length > 0) {
    headers.Cookie = opts.cookies.join("; ");
  }
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      params.set(k, v);
    }
    body = params.toString();
  }
  return fetch(`${DASHBOARD_URL}${path}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
}

type SignUpResult = { userId: string; sessionCookies: string[] };

async function signUpTestUser(): Promise<SignUpResult> {
  const res = await request("POST", "/api/auth/sign-up/email", {
    json: { email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sign-up failed (${res.status}): ${body}`);
  }
  const body: unknown = await res.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("user" in body) ||
    typeof body.user !== "object" ||
    body.user === null ||
    !("id" in body.user) ||
    typeof body.user.id !== "string"
  ) {
    throw new Error("Sign-up response missing user.id");
  }
  const sessionCookies = readSetCookies(res);
  if (sessionCookies.length === 0) {
    throw new Error("Sign-up did not return a session cookie");
  }
  return { userId: body.user.id, sessionCookies };
}

async function createTeam(sessionCookies: string[]): Promise<void> {
  const res = await request("POST", "/settings/teams/new", {
    cookies: sessionCookies,
    form: { name: TEAM_NAME },
  });
  if (res.status !== 302) {
    throw new Error(
      `team creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
    );
  }
  const location = res.headers.get("location") ?? "";
  const match = location.match(/\/settings\/teams\/([^/?#]+)/);
  if (!match) {
    throw new Error(`team creation redirected to unexpected URL: ${location}`);
  }
  if (match[1] !== TEAM_SLUG) {
    throw new Error(
      `expected team slug "${TEAM_SLUG}" but got "${match[1]}" — DO state probably wasn't wiped`,
    );
  }
}

async function createProject(sessionCookies: string[]): Promise<void> {
  const res = await request(
    "POST",
    `/settings/teams/${TEAM_SLUG}/projects/new`,
    {
      cookies: sessionCookies,
      form: { name: PROJECT_NAME },
    },
  );
  if (res.status !== 302) {
    throw new Error(
      `project creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
    );
  }
  // project-new redirects to /settings/teams/<TEAM_SLUG> on success and to
  // /settings/teams/<TEAM_SLUG>/projects/new?error=… on validation
  // failure. Both are 302s, so check the Location to tell them apart.
  const location = res.headers.get("location") ?? "";
  const expectedSuccessPath = `/settings/teams/${TEAM_SLUG}`;
  let locationPath = location;
  try {
    locationPath = new URL(location, DASHBOARD_URL).pathname;
  } catch {
    /* fall through with raw value */
  }
  if (locationPath !== expectedSuccessPath) {
    throw new Error(
      `project creation redirected to unexpected URL: ${location}`,
    );
  }
}

async function mintApiKey(sessionCookies: string[]): Promise<string> {
  const res = await request(
    "POST",
    `/settings/teams/${TEAM_SLUG}/p/${PROJECT_SLUG}/keys`,
    {
      cookies: sessionCookies,
      form: { action: "create", label: "e2e-test" },
    },
  );
  if (res.status !== 302) {
    throw new Error(
      `api key creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
    );
  }
  for (const raw of res.headers.getSetCookie()) {
    const head = raw.split(";")[0];
    const eq = head.indexOf("=");
    if (eq < 0) continue;
    if (head.slice(0, eq) === REVEAL_COOKIE) {
      const value = head.slice(eq + 1);
      if (value) return decodeURIComponent(value);
    }
  }
  throw new Error(
    "key creation succeeded but reveal cookie was missing — cannot recover the plaintext key.",
  );
}

export async function setup(project: TestProject): Promise<void> {
  log("Step 1: Build reporter");
  run("pnpm build", { cwd: REPORTER_DIR });

  log("Step 2: Wipe Durable Object state");
  // All persistent state lives in Durable Objects: auth/tenancy in
  // ControlDO, runs/results/artifacts in TenantDO, realtime progress in
  // SyncedStateServer. Each DO migrates itself lazily on first request, so
  // wiping the on-disk miniflare state is enough to start clean; CI runners
  // are already clean so this is a no-op there.
  for (const name of [
    "wrightful-ControlDO",
    "wrightful-TenantDO",
    "wrightful-SyncedStateServer",
  ]) {
    rmSync(resolve(DASHBOARD_DIR, ".wrangler/state/v3/do", name), {
      recursive: true,
      force: true,
    });
  }

  log("Step 3: Write fake R2 creds + BETTER_AUTH_SECRET to .dev.vars");
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

  log("Step 4: Start dashboard dev server");
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

  log("Step 5: Sign up test user + create team/project/key over HTTP");
  // ControlDO bindings only exist inside the worker, so seeding goes through
  // the running dashboard the same way `scripts/seed-demo.mjs` does:
  //   1. POST /api/auth/sign-up/email           → user + session cookie
  //   2. POST /settings/teams/new               → team (slug from name)
  //   3. POST /settings/teams/:slug/projects/new
  //   4. POST /settings/teams/:slug/p/:slug/keys with action=create
  //      → reveals plaintext key in `wrightful_reveal_key` Set-Cookie
  const { sessionCookies } = await signUpTestUser();
  const sessionCookie = sessionCookies[0];
  await createTeam(sessionCookies);
  await createProject(sessionCookies);
  const apiKey = await mintApiKey(sessionCookies);

  log(
    "Step 6: Run Playwright with the reporter — streams a real run into the dashboard",
  );
  if (existsSync(REPORT_PATH)) unlinkSync(REPORT_PATH);
  try {
    // WRIGHTFUL_URL / WRIGHTFUL_TOKEN pick up in the reporter's onBegin;
    // playwright.config.ts is already wired to load @wrightful/reporter.
    run("npx playwright test", {
      cwd: E2E_DIR,
      env: {
        ...process.env,
        WRIGHTFUL_URL: DASHBOARD_URL,
        WRIGHTFUL_TOKEN: apiKey,
      },
    });
  } catch {
    // Some demo tests may fail — that's fine, we only need the streamed data.
  }
  if (!existsSync(REPORT_PATH)) {
    throw new Error("Playwright did not generate a JSON report");
  }

  project.provide("dashboardUrl", DASHBOARD_URL);
  project.provide("apiKey", apiKey);
  project.provide("reportPath", REPORT_PATH);
  project.provide("dashboardDir", DASHBOARD_DIR);
  project.provide("sessionCookie", sessionCookie);
  project.provide("teamSlug", TEAM_SLUG);
  project.provide("projectSlug", PROJECT_SLUG);
  project.provide("betterAuthSecret", BETTER_AUTH_SECRET);
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
    dashboardDir: string;
    sessionCookie: string;
    teamSlug: string;
    projectSlug: string;
    betterAuthSecret: string;
  }
}
