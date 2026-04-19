// Runs the fixture Playwright suite in multiple scenarios, then invokes the
// real `wrightful upload` CLI against a locally running dashboard. Seeds
// genuine ingest + artifact rows end-to-end — includes traces, videos, and
// screenshots in R2.
//
// Requires `.dev.vars.seed.json` from `pnpm db:seed-demo` (run automatically
// as part of `pnpm setup:local`). If the dashboard dev server isn't already
// running on :5173, this script spawns one temporarily and kills it on exit.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { startSpinner } from "./lib/spinner.mjs";

const dashboardDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const seedPath = new URL("../.dev.vars.seed.json", import.meta.url).pathname;
const playwrightDir = new URL("../fixtures/playwright/", import.meta.url)
  .pathname;

if (!existsSync(seedPath)) {
  console.error(
    pc.red(
      "missing .dev.vars.seed.json — run `pnpm setup:local` first (it seeds the demo user).",
    ),
  );
  process.exit(1);
}

const seed = JSON.parse(readFileSync(seedPath, "utf8"));
// WRIGHTFUL_URL lets `setup:local` point us at a fallback port when 5173
// is busy. Falls back to the seeded URL when invoked standalone.
const baseUrl = process.env.WRIGHTFUL_URL || seed.url;
const QUIET = process.env.WRIGHTFUL_QUIET === "1";
const log = (...args) => {
  if (!QUIET) console.log(...args);
};

async function probe() {
  try {
    const res = await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${seed.apiKey}`,
      },
      body: "{}",
    });
    // 400 = server up, auth accepted, body invalid (expected).
    // 401 = auth rejected — caller should surface a clearer error.
    // anything else = not our server / not ready.
    return res.status;
  } catch {
    return null;
  }
}

let devServer = null;

async function ensureDashboardRunning() {
  const initial = await probe();
  if (initial === 400) return;
  if (initial === 401) {
    console.error(
      "dashboard rejected the demo API key. Wipe D1 and re-run `pnpm setup:local`.",
    );
    process.exit(1);
  }

  log(`dashboard not reachable at ${baseUrl} — starting dev server…`);
  devServer = spawn("pnpm", ["--filter", "@wrightful/dashboard", "dev"], {
    cwd: repoRoot,
    stdio: "ignore",
    detached: false,
  });
  const killDev = () => {
    if (devServer && !devServer.killed) devServer.kill("SIGTERM");
  };
  process.on("exit", killDev);
  process.on("SIGINT", () => {
    killDev();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killDev();
    process.exit(143);
  });

  // Poll for readiness — the vite plugin + wrangler miniflare startup can
  // take a few seconds on a cold cache.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await probe();
    if (status === 400) {
      log("dashboard is up");
      return;
    }
    if (status === 401) {
      console.error(
        "dashboard rejected the demo API key. Wipe D1 and re-run `pnpm setup:local`.",
      );
      process.exit(1);
    }
  }
  console.error("dashboard did not become ready within 90s — aborting");
  process.exit(1);
}

await ensureDashboardRunning();

// ---------- Ensure CLI is built ----------

const stopBuildSpinner = QUIET
  ? () => {}
  : startSpinner(`  ${pc.dim("›")} ${"building CLI…".padEnd(30)} `);
const build = await new Promise((resolve) => {
  const child = spawn("pnpm", ["--filter", "@wrightful/cli", "build"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("exit", (code) => resolve({ status: code ?? 1, stdout, stderr }));
});
stopBuildSpinner();
if (build.status !== 0) {
  if (QUIET)
    process.stdout.write(`  ${pc.dim("›")} ${"building CLI…".padEnd(30)} `);
  console.log(pc.red("failed"));
  process.stderr.write(build.stdout);
  process.stderr.write(build.stderr);
  process.exit(build.status);
}
log(pc.green("done"));

const cliBin = new URL("../../cli/dist/index.js", import.meta.url).pathname;

// ---------- Scenarios ----------

const SCENARIOS = [
  {
    label: "01-main-green",
    branch: "main",
    sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    buildId: "fixture-build-01",
    includeFailures: false,
  },
  {
    label: "02-feature-flaky",
    branch: "feat/discount-codes",
    sha: "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0",
    buildId: "fixture-build-02",
    includeFailures: true,
  },
  {
    label: "03-main-historical",
    branch: "main",
    sha: "c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
    buildId: "fixture-build-03",
    includeFailures: false,
  },
];

/**
 * Run a subprocess with stdout/stderr captured. Returns exit code + merged
 * output so the caller decides whether to surface the noise (on failure) or
 * swallow it (on success).
 *
 * @returns {Promise<{ code: number, output: string }>}
 */
function runCaptured(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function runScenario(scenario, index, total) {
  const counter = pc.dim(`[${index + 1}/${total}]`);
  const label = `  ${counter} ${scenario.label}…`;
  // padEnd can't measure ANSI-coloured width, so pad the plain version.
  const plainLen = `  [${index + 1}/${total}] ${scenario.label}…`.length;
  const prefix = label + " ".repeat(Math.max(1, 34 - plainLen));
  const stopSpinner = startSpinner(prefix);

  const resultsDir = `${playwrightDir}test-results/${scenario.label}`;
  const reportPath = `${resultsDir}/report.json`;
  rmSync(resultsDir, { recursive: true, force: true });

  const pwEnv = {
    ...process.env,
    WRIGHTFUL_FIXTURE_REPORT: reportPath,
    WRIGHTFUL_FIXTURE_FAILURES: scenario.includeFailures ? "1" : "0",
    PLAYWRIGHT_OUTPUT_DIR: resultsDir,
  };

  const pw = await runCaptured(
    "npx",
    [
      "playwright",
      "test",
      "--config",
      `${playwrightDir}playwright.config.ts`,
      "--output",
      resultsDir,
    ],
    { cwd: dashboardDir, env: pwEnv },
  );

  // Playwright exits non-zero on any test failure. Scenarios that
  // *intentionally* include failures tolerate exit 1 — everything else should
  // stay green, and we bail on unexpected failures or a missing report.
  if (pw.code !== 0 && !scenario.includeFailures) {
    stopSpinner();
    console.log(pc.red("failed"));
    console.error(
      `\nplaywright exited ${pw.code} on an all-green scenario — output:\n`,
    );
    process.stderr.write(pw.output);
    process.exit(pw.code);
  }

  if (!existsSync(reportPath)) {
    stopSpinner();
    console.log(pc.red("failed"));
    console.error(`\nno report at ${reportPath} — playwright output:\n`);
    process.stderr.write(pw.output);
    process.exit(1);
  }

  const uploadEnv = {
    ...process.env,
    WRIGHTFUL_URL: baseUrl,
    WRIGHTFUL_API_KEY: seed.apiKey,
    // Spoof GitHub Actions CI detection so the run gets stamped with branch/
    // commit/build id without modifying the CLI.
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: scenario.buildId,
    GITHUB_REF_NAME: scenario.branch,
    GITHUB_SHA: scenario.sha,
    GITHUB_REPOSITORY: "wrightful/example-shop",
  };

  const upload = await runCaptured(
    "node",
    [cliBin, "upload", "--artifacts", "all", reportPath],
    { cwd: dashboardDir, env: uploadEnv },
  );

  if (upload.code !== 0) {
    stopSpinner();
    console.log(pc.red("failed"));
    console.error(
      `\nupload failed for ${scenario.label} (exit ${upload.code}) — output:\n`,
    );
    process.stderr.write(upload.output);
    process.exit(upload.code);
  }

  stopSpinner();
  console.log(pc.green("done"));
}

for (let i = 0; i < SCENARIOS.length; i++) {
  await runScenario(SCENARIOS[i], i, SCENARIOS.length);
}

if (!QUIET) {
  console.log(pc.green(`\n✓ sign in at ${seed.url} as ${seed.email}`));
  if (baseUrl !== seed.url) {
    console.log(
      pc.dim(
        `  (fixtures were uploaded against ${baseUrl}; ${seed.url} is where \`pnpm dev\` binds)`,
      ),
    );
  }
}
