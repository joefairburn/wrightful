// `seed:stream` — drive ONE run of the seed Playwright suite SLOWLY through the
// real @wrightful/reporter into your running local dashboard, so you can watch
// a run stream in live (rows, artifacts, mixed outcomes) on the run page.
//
// Unlike `fixtures:generate` (bulk seeding: many scenarios, fast, output
// swallowed), this runs a single run serially with a per-test delay
// (SEED_DELAY_MS, default 1500ms) and streams Playwright's output so you see
// progress. It always includes the failure/flaky/visual specs so the run shows
// every outcome the dashboard renders.
//
// Reuses the seed suite + the dev-server readiness helper from
// `upload-fixtures.mjs`. Requires `.env.seed.json` (from `pnpm setup:local`) or
// WRIGHTFUL_URL + WRIGHTFUL_TOKEN env pointing at a running dashboard.
//
// Env:
//   SEED_DELAY_MS   per-test delay in ms (default 1500). 0 = no pacing.
//   WRIGHTFUL_URL / WRIGHTFUL_TOKEN   point at a specific dashboard (else
//                                     falls back to .env.seed.json).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { ensureDashboardRunning } from "./lib/dev-server.mjs";
import { makePrng, sha40 } from "./seed/catalog.mjs";

const dashboardDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const seedPath = new URL("../.env.seed.json", import.meta.url).pathname;
const playwrightDir = new URL("./seed/playwright/", import.meta.url).pathname;
const reporterDist = new URL(
  "../../../packages/reporter/dist/index.js",
  import.meta.url,
).pathname;

// ---------- Credentials (env wins, else .env.seed.json) ----------
const envUrl = process.env.WRIGHTFUL_URL;
const envToken = process.env.WRIGHTFUL_TOKEN;
let seed;
if (envUrl && envToken) {
  seed = {
    url: envUrl,
    apiKey: envToken,
    teamSlug: process.env.WRIGHTFUL_TEAM ?? null,
    projectSlug: process.env.WRIGHTFUL_PROJECT ?? null,
  };
} else if (existsSync(seedPath)) {
  seed = JSON.parse(readFileSync(seedPath, "utf8"));
} else {
  console.error(
    pc.red(
      "missing .env.seed.json — run `pnpm setup:local` first, or pass " +
        "WRIGHTFUL_URL + WRIGHTFUL_TOKEN to point at a running dashboard.",
    ),
  );
  process.exit(1);
}
const apiKey = envToken || seed.apiKey;

// ---------- Ensure the dashboard is reachable ----------
// seed:stream streams INTO the dashboard you're running via `pnpm dev`, so it
// targets that server's fixed port (vite `strictPort: 5173`, see vite.config).
// It deliberately does NOT use `seed.url` from .env.seed.json: that's the
// throwaway DYNAMIC port `setup:local` spun up to seed and then killed, so it's
// stale — and even if a stray server is still listening there, it's a SEPARATE
// instance with its own Durable Objects, so streaming to it publishes live
// events the :5173 page you're watching never receives (data still lands via
// the shared local D1, hence "updates only on refresh"). WRIGHTFUL_URL still
// overrides for a remote/custom target.
//
// Reuses the shared readiness contract (empty-body POST /api/runs → 400 = ready)
// and on-demand spawn. The common path is "already running" — you'll have
// `pnpm dev` up on :5173 — in which case nothing is spawned and nothing is torn
// down.
const DEV_SERVER_URL = "http://localhost:5173";
const { baseUrl } = await ensureDashboardRunning(
  { url: envUrl ?? DEV_SERVER_URL, apiKey },
  {
    // Remediation depends on where creds came from — mirror upload-fixtures.mjs
    // so env-mode 401s don't wrongly tell you to wipe .env.seed.json / local D1.
    onAuthRejected: (url) => {
      console.error(
        pc.red(
          envUrl && envToken
            ? `dashboard at ${url} rejected the supplied API key — re-check WRIGHTFUL_URL + WRIGHTFUL_TOKEN.`
            : "dashboard rejected the demo API key. Delete `.env.seed.json` and `.wrangler/state/v3/d1/` then re-run `pnpm setup:local`.",
        ),
      );
      process.exit(1);
    },
  },
);

// ---------- Ensure the reporter is built ----------
// Playwright loads the reporter from packages/reporter/dist/index.js. Build it
// only when missing so repeat `seed:stream` runs stay snappy.
if (!existsSync(reporterDist)) {
  process.stdout.write(`${pc.dim("›")} building reporter… `);
  const build = await new Promise((resolve) => {
    const child = spawn("pnpm", ["--filter", "@wrightful/reporter", "build"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
  if (build.code !== 0) {
    console.log(pc.red("failed"));
    process.stderr.write(build.out);
    process.exit(build.code);
  }
  console.log(pc.green("done"));
}

// ---------- Stream one run, slowly ----------
const delayMs = process.env.SEED_DELAY_MS ?? "1500";
// Unique build id per invocation so each run is fresh (the reporter derives its
// idempotency key from the CI build id; a fixed id would dedupe re-runs).
const buildId = `stream-${Date.now()}`;

// Point the developer at their runs list so they can watch the new run appear.
const runsUrl =
  seed.teamSlug && seed.projectSlug
    ? `${baseUrl}/t/${seed.teamSlug}/p/${seed.projectSlug}`
    : null;
console.log(
  pc.cyan(
    `\n▶ streaming a run (≈${delayMs}ms/test). Watch it fill in live at:\n  ${
      runsUrl ?? `${baseUrl} (open your project's runs list)`
    }\n`,
  ),
);

// Spoof GitHub Actions CI so the run is stamped with branch / commit / build id
// (same approach as upload-fixtures.mjs). Strip any ambient GITHUB_* first so a
// PR's CI env doesn't bleed into the demo run's metadata.
const {
  GITHUB_HEAD_REF: _ghHead,
  GITHUB_REF_NAME: _ghRefName,
  GITHUB_RUN_ID: _ghRunId,
  GITHUB_SHA: _ghSha,
  GITHUB_REPOSITORY: _ghRepo,
  ...envWithoutGithub
} = process.env;

const pwEnv = {
  ...envWithoutGithub,
  SEED_DELAY_MS: delayMs,
  // Include the deliberate failure / flaky / visual-diff specs so the streamed
  // run exercises every outcome + the artifact + visual-diff pipelines.
  WRIGHTFUL_FIXTURE_FAILURES: "1",
  WRIGHTFUL_URL: baseUrl,
  WRIGHTFUL_TOKEN: apiKey,
  GITHUB_ACTIONS: "true",
  GITHUB_RUN_ID: buildId,
  GITHUB_REF_NAME: "feat/live-stream-demo",
  GITHUB_SHA: sha40(makePrng(buildId)),
  GITHUB_REPOSITORY: "wrightful/example-shop",
};

// `--workers=1` so test completions (and therefore the streamed rows) arrive
// one at a time rather than bunching across parallel workers. stdio inherited
// so the reporter's live progress + summary stream to your terminal.
const pw = spawn(
  "npx",
  [
    "playwright",
    "test",
    "--config",
    `${playwrightDir}playwright.config.ts`,
    "--workers=1",
  ],
  { cwd: dashboardDir, env: pwEnv, stdio: "inherit" },
);

// A spawn failure (e.g. npx/playwright not found) emits "error", not "exit";
// without a listener Node would re-throw it as a bare uncaught exception.
let settled = false;
pw.on("error", (err) => {
  if (settled) return;
  settled = true;
  console.error(pc.red(`\nfailed to launch Playwright: ${err.message}`));
  process.exit(1);
});
pw.on("exit", () => {
  if (settled) return;
  settled = true;
  // The suite includes deliberate failures, so Playwright exits non-zero by
  // design. The goal here is to stream a run, not to assert green — so report
  // success and point back at the runs list.
  if (runsUrl) console.log(pc.green(`\n✓ run streamed — ${runsUrl}`));
  process.exit(0);
});
