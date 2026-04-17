// Runs the fixture Playwright suite in multiple scenarios, then invokes the
// real `wrightful upload` CLI against a locally running dashboard. Seeds
// genuine ingest + artifact rows end-to-end — includes traces, videos, and
// screenshots in R2.
//
// Requires `.dev.vars.seed.json` from `pnpm db:seed-demo` (run automatically
// as part of `pnpm setup:local`). If the dashboard dev server isn't already
// running on :5173, this script spawns one temporarily and kills it on exit.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dashboardDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const seedPath = new URL("../.dev.vars.seed.json", import.meta.url).pathname;
const playwrightDir = new URL("../fixtures/playwright/", import.meta.url)
  .pathname;

if (!existsSync(seedPath)) {
  console.error(
    "missing .dev.vars.seed.json — run `pnpm setup:local` first (it seeds the demo user).",
  );
  process.exit(1);
}

const seed = JSON.parse(readFileSync(seedPath, "utf8"));

async function probe() {
  try {
    const res = await fetch(`${seed.url}/api/ingest`, {
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

  console.log(`dashboard not reachable at ${seed.url} — starting dev server…`);
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
      console.log("dashboard is up");
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

console.log("building @wrightful/cli…");
const build = spawnSync("pnpm", ["--filter", "@wrightful/cli", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const cliBin = new URL("../../cli/dist/index.js", import.meta.url).pathname;

// ---------- Scenarios ----------

const SCENARIOS = [
  {
    label: "01-main-green",
    branch: "main",
    sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    buildId: "fixture-build-01",
    chaos: false,
  },
  {
    label: "02-feature-flaky",
    branch: "feat/discount-codes",
    sha: "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0",
    buildId: "fixture-build-02",
    chaos: true,
  },
  {
    label: "03-main-historical",
    branch: "main",
    sha: "c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
    buildId: "fixture-build-03",
    chaos: false,
  },
];

/**
 * @returns {Promise<number>}
 */
function runSubprocess(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function runScenario(scenario) {
  console.log(`\n━━━ scenario: ${scenario.label} ━━━`);

  // Fresh results dir per scenario so Playwright output doesn't bleed between
  // runs.
  const resultsDir = `${playwrightDir}test-results/${scenario.label}`;
  const reportPath = `${resultsDir}/report.json`;
  rmSync(resultsDir, { recursive: true, force: true });

  const pwEnv = {
    ...process.env,
    WRIGHTFUL_FIXTURE_REPORT: reportPath,
    WRIGHTFUL_FIXTURE_CHAOS: scenario.chaos ? "1" : "0",
    PLAYWRIGHT_OUTPUT_DIR: resultsDir,
  };

  const pwCode = await runSubprocess(
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

  // Playwright exits non-zero on any test failure. The chaos scenario is
  // *supposed* to have failures — so we tolerate exit 1 there and only bail
  // on harder errors.
  if (pwCode !== 0 && !scenario.chaos) {
    console.error(
      `playwright exited ${pwCode} on non-chaos scenario — aborting`,
    );
    process.exit(pwCode);
  }

  if (!existsSync(reportPath)) {
    console.error(`no report at ${reportPath} — playwright run failed hard`);
    process.exit(1);
  }

  const uploadEnv = {
    ...process.env,
    WRIGHTFUL_URL: seed.url,
    WRIGHTFUL_API_KEY: seed.apiKey,
    // Spoof GitHub Actions CI detection so the run gets stamped with branch/
    // commit/build id without modifying the CLI.
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: scenario.buildId,
    GITHUB_REF_NAME: scenario.branch,
    GITHUB_SHA: scenario.sha,
    GITHUB_REPOSITORY: "wrightful/example-shop",
  };

  const uploadCode = await runSubprocess(
    "node",
    [cliBin, "upload", "--artifacts", "all", reportPath],
    { cwd: dashboardDir, env: uploadEnv },
  );

  if (uploadCode !== 0) {
    console.error(`upload failed for ${scenario.label} (exit ${uploadCode})`);
    process.exit(uploadCode);
  }
}

for (const scenario of SCENARIOS) {
  await runScenario(scenario);
}

console.log("\n✓ all fixtures uploaded");
console.log(`  sign in at ${seed.url} as ${seed.email}`);
