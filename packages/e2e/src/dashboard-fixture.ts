/**
 * Shared "boot the dashboard with a seeded user/team/project/API key" helper.
 *
 * Used by both the Vitest e2e suite (packages/e2e/vitest.globalSetup.ts) and
 * the Playwright UI suite (packages/e2e/tests-dashboard/global-setup.ts). Each
 * suite needs the same fixture: a running dashboard the tests can hit, plus
 * the credentials a real user would have. Extracted so the boot logic doesn't
 * drift between the two consumers.
 *
 * Lifecycle: `bootDashboard(...)` returns a `DashboardFixture` whose `.teardown()`
 * kills the dev server and restores the original `.dev.vars`. Always pair the
 * call with a `finally`/teardown hook — the dashboard listens on a fixed port,
 * so a leaked process blocks the next run.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DASHBOARD_DIR = resolve(ROOT, "packages/dashboard");
const REPORTER_DIR = resolve(ROOT, "packages/reporter");
const DEV_VARS_PATH = resolve(DASHBOARD_DIR, ".dev.vars");

const REVEAL_COOKIE = "wrightful_reveal_key";

export interface BootOptions {
  /** TCP port the dev server should listen on. */
  port: number;
  /**
   * Local-only Better Auth secret. The Playwright + Vitest suites both forge
   * artifact-download HMAC tokens with this, so it has to match the value the
   * dashboard runs under. Default is fine unless a caller is doing something
   * exotic.
   */
  betterAuthSecret?: string;
  /** Slug + display name of the seeded team. Defaults to `e2e` / `E2E`. */
  teamSlug?: string;
  teamName?: string;
  /** Slug + display name of the seeded project. Defaults to `demo` / `Demo`. */
  projectSlug?: string;
  projectName?: string;
  /** Email + password + name for the seeded test user. */
  email?: string;
  password?: string;
  userName?: string;
  /** Distinct path so concurrent suites don't collide on .dev.vars backup. */
  devVarsBackupSuffix?: string;
}

export interface DashboardFixture {
  url: string;
  apiKey: string;
  sessionCookie: string;
  /** All Set-Cookie name=value pairs from sign-up, suitable for further auth'd HTTP. */
  sessionCookies: string[];
  teamSlug: string;
  projectSlug: string;
  betterAuthSecret: string;
  email: string;
  password: string;
  /** Kills the dev server and restores `.dev.vars`. Idempotent. */
  teardown: () => void;
}

function log(msg: string): void {
  console.log(`[dashboard-fixture] ${msg}`);
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

function readSetCookies(res: Response): string[] {
  return res.headers.getSetCookie().map((raw) => raw.split(";")[0]);
}

interface RequestOpts {
  cookies?: string[];
  json?: unknown;
  form?: Record<string, string>;
}

function makeRequester(baseUrl: string) {
  return async function request(
    method: string,
    path: string,
    opts: RequestOpts = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: baseUrl,
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
      for (const [k, v] of Object.entries(opts.form)) params.set(k, v);
      body = params.toString();
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      redirect: "manual",
    });
  };
}

export async function bootDashboard(
  options: BootOptions,
): Promise<DashboardFixture> {
  const port = options.port;
  const url = `http://localhost:${port}`;
  const teamSlug = options.teamSlug ?? "e2e";
  const teamName = options.teamName ?? "E2E";
  const projectSlug = options.projectSlug ?? "demo";
  const projectName = options.projectName ?? "Demo";
  const email = options.email ?? "e2e@wrightful.test";
  const password = options.password ?? "e2e-e2e-e2e-password";
  const userName = options.userName ?? "E2E Tester";
  const betterAuthSecret =
    options.betterAuthSecret ??
    "e2e-local-only-not-a-secret-openssl-rand-base64-32ch";

  const backupSuffix = options.devVarsBackupSuffix ?? "e2e-backup";
  const devVarsBackupPath = resolve(DASHBOARD_DIR, `.dev.vars.${backupSuffix}`);

  let devServer: ChildProcess | undefined;
  let devVarsBackedUp = false;
  let tornDown = false;

  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    if (devServer) {
      devServer.kill("SIGTERM");
      devServer = undefined;
    }
    if (!devVarsBackedUp) return;
    try {
      if (existsSync(devVarsBackupPath)) {
        if (existsSync(DEV_VARS_PATH)) unlinkSync(DEV_VARS_PATH);
        renameSync(devVarsBackupPath, DEV_VARS_PATH);
      } else if (existsSync(DEV_VARS_PATH)) {
        unlinkSync(DEV_VARS_PATH);
      }
      devVarsBackedUp = false;
    } catch (err) {
      console.error(`[dashboard-fixture] Failed to restore .dev.vars:`, err);
    }
  };

  try {
    log("Step 1: Build reporter");
    run("pnpm build", { cwd: REPORTER_DIR });

    log("Step 2: Wipe Durable Object state");
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

    log("Step 3: Write .dev.vars (backup any existing)");
    if (existsSync(devVarsBackupPath)) {
      throw new Error(
        `Refusing to start: ${devVarsBackupPath} already exists. A previous run likely crashed before teardown. Inspect it and restore/remove manually.`,
      );
    }
    if (existsSync(DEV_VARS_PATH)) {
      renameSync(DEV_VARS_PATH, devVarsBackupPath);
      log("  Existing .dev.vars backed up.");
    }
    devVarsBackedUp = true;
    const devVars =
      [
        `BETTER_AUTH_SECRET=${betterAuthSecret}`,
        `WRIGHTFUL_PUBLIC_URL=${url}`,
        // Sign-up gate is locked in production; e2e provisions a user via
        // /api/auth/sign-up/email so we explicitly opt in here.
        `ALLOW_OPEN_SIGNUP=1`,
      ].join("\n") + "\n";
    writeFileSync(DEV_VARS_PATH, devVars, "utf8");

    log(`Step 4: Start dashboard dev server on :${port}`);
    devServer = spawn("npx", ["vite", "dev", "--port", String(port)], {
      cwd: DASHBOARD_DIR,
      stdio: "pipe",
      env: { ...process.env },
    });
    let serverLog = "";
    devServer.stdout?.on("data", (d) => (serverLog += d.toString()));
    devServer.stderr?.on("data", (d) => (serverLog += d.toString()));
    try {
      await waitForServer(url);
    } catch (err) {
      console.error(
        `\n[dashboard-fixture] Dev server failed to start. Output so far:\n${serverLog}`,
      );
      throw err;
    }
    log("  Dashboard ready.");

    log("Step 5: Sign up + create team/project/key over HTTP");
    const request = makeRequester(url);

    // sign-up
    const signupRes = await request("POST", "/api/auth/sign-up/email", {
      json: { email, password, name: userName },
    });
    if (!signupRes.ok) {
      const body = await signupRes.text();
      throw new Error(`Sign-up failed (${signupRes.status}): ${body}`);
    }
    const sessionCookies = readSetCookies(signupRes);
    if (sessionCookies.length === 0) {
      throw new Error("Sign-up did not return a session cookie");
    }
    const sessionCookie = sessionCookies[0];

    // team
    const teamRes = await request("POST", "/settings/teams/new", {
      cookies: sessionCookies,
      form: { name: teamName },
    });
    if (teamRes.status !== 302) {
      throw new Error(
        `team creation returned ${teamRes.status}: ${(await teamRes.text()) || "(empty body)"}`,
      );
    }
    const teamLoc = teamRes.headers.get("location") ?? "";
    const teamMatch = teamLoc.match(/\/settings\/teams\/([^/?#]+)/);
    if (!teamMatch || teamMatch[1] !== teamSlug) {
      throw new Error(
        `expected team slug "${teamSlug}", got Location "${teamLoc}" — DO state probably wasn't wiped`,
      );
    }

    // project
    const projectRes = await request(
      "POST",
      `/settings/teams/${teamSlug}/projects/new`,
      { cookies: sessionCookies, form: { name: projectName } },
    );
    if (projectRes.status !== 302) {
      throw new Error(
        `project creation returned ${projectRes.status}: ${(await projectRes.text()) || "(empty body)"}`,
      );
    }
    const expectedProjectLoc = `/settings/teams/${teamSlug}`;
    const projectLoc = projectRes.headers.get("location") ?? "";
    let projectLocPath = projectLoc;
    try {
      projectLocPath = new URL(projectLoc, url).pathname;
    } catch {
      /* fall through */
    }
    if (projectLocPath !== expectedProjectLoc) {
      throw new Error(
        `project creation redirected to unexpected URL: ${projectLoc}`,
      );
    }

    // api key
    const keyRes = await request(
      "POST",
      `/settings/teams/${teamSlug}/p/${projectSlug}/keys`,
      { cookies: sessionCookies, form: { action: "create", label: "e2e" } },
    );
    if (keyRes.status !== 302) {
      throw new Error(
        `api key creation returned ${keyRes.status}: ${(await keyRes.text()) || "(empty body)"}`,
      );
    }
    let apiKey: string | undefined;
    for (const raw of keyRes.headers.getSetCookie()) {
      const head = raw.split(";")[0];
      const eq = head.indexOf("=");
      if (eq < 0) continue;
      if (head.slice(0, eq) === REVEAL_COOKIE) {
        const value = head.slice(eq + 1);
        if (value) apiKey = decodeURIComponent(value);
      }
    }
    if (!apiKey) {
      throw new Error(
        "key creation succeeded but reveal cookie was missing — cannot recover the plaintext key.",
      );
    }

    return {
      url,
      apiKey,
      sessionCookie,
      sessionCookies,
      teamSlug,
      projectSlug,
      betterAuthSecret,
      email,
      password,
      teardown,
    };
  } catch (err) {
    teardown();
    throw err;
  }
}
