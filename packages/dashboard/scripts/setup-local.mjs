import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { startSpinner } from "./lib/spinner.mjs";
import { probeDashboard, startDevServerForSeed } from "./lib/dev-server.mjs";

// Local-dev bootstrap.
//
// Flow:
//   1. Create `.dev.vars` if missing (with a random BETTER_AUTH_SECRET and
//      ALLOW_OPEN_SIGNUP=1 enabled so the seed can call /api/auth/sign-up).
//   2. Start `vite dev` and wait for the worker to respond. Miniflare
//      provisions the Durable Objects; each DO migrates its schema lazily
//      on first access via rwsdk's init pattern.
//   3. Run `seed-demo.mjs` against the running server. It signs up via
//      Better Auth's HTTP API, creates team + project, mints an API key.
//   4. Optionally upload Playwright fixture data via the API key.
//   5. Optionally synthesize months of run history.

const dashboardDir = new URL("..", import.meta.url);
const envUrl = new URL(".dev.vars", dashboardDir);
const exampleUrl = new URL(".dev.vars.example", dashboardDir);
const seedConfigUrl = new URL(".dev.vars.seed.json", dashboardDir);

const LABEL_WIDTH = 34;
const stageLabel = (label) => `${pc.dim("›")} ${label.padEnd(LABEL_WIDTH)} `;

/**
 * Run `label… <spinner>` in place, capturing stdout/stderr and only surfacing
 * them when the step fails. On completion, replaces the spinner with `done` /
 * `failed`. Returns the child result so callers can inspect status.
 */
async function stage(label, cmd, args, opts = {}) {
  const stop = startSpinner(stageLabel(label));
  const child = spawn(cmd, args, {
    cwd: dashboardDir,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  stop();
  if (status !== 0) {
    console.log(pc.red("failed"));
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(status ?? 1);
  }
  console.log(pc.green("done"));
  return { stdout, stderr, status };
}

// ---------- .dev.vars ----------

/**
 * Ensure `ALLOW_OPEN_SIGNUP=1` is set in the given .dev.vars text. The seed
 * flow needs it; without it Better Auth returns 403 on /api/auth/sign-up.
 *
 * Returns the updated text and whether anything changed.
 *
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
function ensureOpenSignup(text) {
  // Already enabled (uncommented).
  if (/^\s*ALLOW_OPEN_SIGNUP=1/m.test(text)) {
    return { text, changed: false };
  }
  // Commented-out variant — uncomment.
  if (/^#\s*ALLOW_OPEN_SIGNUP=1/m.test(text)) {
    return {
      text: text.replace(/^#\s*ALLOW_OPEN_SIGNUP=1/m, "ALLOW_OPEN_SIGNUP=1"),
      changed: true,
    };
  }
  // Missing entirely — append.
  const sep = text.endsWith("\n") ? "" : "\n";
  return { text: `${text}${sep}ALLOW_OPEN_SIGNUP=1\n`, changed: true };
}

if (existsSync(envUrl)) {
  const current = readFileSync(envUrl, "utf8");
  const { text: updated, changed } = ensureOpenSignup(current);
  if (changed) {
    writeFileSync(envUrl, updated);
    console.log(
      `${stageLabel("updating .dev.vars…")}${pc.yellow(
        "added ALLOW_OPEN_SIGNUP=1",
      )}`,
    );
  } else {
    console.log(
      `${stageLabel("checking .dev.vars…")}${pc.dim("already present")}`,
    );
  }
} else {
  const template = readFileSync(exampleUrl, "utf8");
  const randomSecret = () =>
    Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString(
      "base64",
    );
  const filled = template.replace(
    "replace-me-with-better-auth-secret",
    randomSecret(),
  );
  const { text: withSignup } = ensureOpenSignup(filled);
  writeFileSync(envUrl, withSignup);
  console.log(`${stageLabel("creating .dev.vars…")}${pc.green("done")}`);
}

// ---------- Dev server ----------

// Always start the dev server fresh with live-streaming output. The
// unauthenticated probe inside `startDevServerForSeed` works regardless
// of whether a previous seed file exists or whether its API key is still
// valid against the current ControlDO state.
const force = process.argv.includes("--reseed");
const hadSeed = existsSync(seedConfigUrl);
const { baseUrl, spawned: spawnedServer } = await startDevServerForSeed({
  labelWidth: LABEL_WIDTH,
});

// ---------- Seed (or skip if existing seed key is still valid) ----------

let needsSeed = !hadSeed || force;
if (hadSeed && !force) {
  // Verify the existing seed file still works against this dashboard.
  // 400 = key valid, body invalid (expected). 401 = key rejected (stale —
  // re-seed). Anything else = unclear, lean toward re-seeding to recover.
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );
  const status = await probeDashboard(baseUrl, seedConfig.apiKey);
  if (status === 400) {
    console.log(`${stageLabel("existing seed key…")}${pc.dim("still valid")}`);
    needsSeed = false;
  } else if (status === 401) {
    console.log(
      `${stageLabel("existing seed key…")}${pc.yellow("stale — re-seeding")}`,
    );
    needsSeed = true;
  } else {
    console.log(
      `${stageLabel("existing seed key…")}${pc.yellow(
        `inconclusive (status=${status ?? "no response"}) — re-seeding`,
      )}`,
    );
    needsSeed = true;
  }
}

if (needsSeed) {
  await stage(
    hadSeed ? "re-seeding demo account…" : "seeding demo account…",
    "node",
    ["scripts/seed-demo.mjs"],
    {
      env: {
        ...process.env,
        WRIGHTFUL_QUIET: "1",
        WRIGHTFUL_BASE_URL: baseUrl,
      },
    },
  );
}

// ---------- Fixtures (optional) ----------

// `--history` synthesizes months of test runs via the ingest API — much
// more data than the 3 canned Playwright scenarios, at the cost of no real
// artifacts. Implies `--no-fixtures`.
const withHistory = process.argv.includes("--history");
const historyMonths = (() => {
  const i = process.argv.indexOf("--history-months");
  const v = i >= 0 ? Number(process.argv[i + 1]) : 3;
  return Number.isFinite(v) && v > 0 ? v : 3;
})();
const historySeed = (() => {
  const i = process.argv.indexOf("--history-seed");
  return i >= 0 ? (process.argv[i + 1] ?? "") : "wrightful-seed-1";
})();

const skipFixtures = process.argv.includes("--no-fixtures") || withHistory;

if (!skipFixtures) {
  if (!existsSync(seedConfigUrl)) {
    console.error(
      pc.red(
        "\n.dev.vars.seed.json is missing — seed step must have failed. Re-run `pnpm setup:local`.",
      ),
    );
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    process.exit(1);
  }
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );

  console.log(`\n${pc.bold("generating example test data")}`);
  const fixturesArgs = ["scripts/upload-fixtures.mjs"];
  if (process.argv.includes("--volume")) fixturesArgs.push("--volume");
  const fixtures = spawnSync("node", fixturesArgs, {
    stdio: "inherit",
    cwd: dashboardDir,
    env: {
      ...process.env,
      WRIGHTFUL_QUIET: "1",
      WRIGHTFUL_URL: baseUrl,
      WRIGHTFUL_TOKEN: seedConfig.apiKey,
    },
  });

  if (fixtures.status !== 0) {
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    console.error(
      pc.red(
        "\nfixture generation failed — demo user still seeded. Retry with `pnpm fixtures:generate`.",
      ),
    );
    process.exit(fixtures.status ?? 1);
  }
}

// ---------- Synthesized history (optional) ----------

if (withHistory) {
  if (!existsSync(seedConfigUrl)) {
    console.error(
      pc.red(
        "\n.dev.vars.seed.json is missing — cannot seed history without the demo API key.",
      ),
    );
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    process.exit(1);
  }
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );
  const { generateHistory } = await import("./seed/generator.mjs");

  console.log(
    `\n${pc.bold(`generating ${historyMonths} months of history (seed=${historySeed})`)}`,
  );
  const { runs } = generateHistory({
    months: historyMonths,
    seed: historySeed,
  });
  console.log(`${stageLabel("runs to ingest…")}${pc.cyan(runs.length)}`);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${seedConfig.apiKey}`,
    "X-Wrightful-Version": "3",
  };
  const BATCH_SIZE = 50;
  const postJson = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };

  let completed = 0;
  let failedCount = 0;
  const startedAt = Date.now();
  const stopSpin = startSpinner(stageLabel("ingesting runs…"));
  for (const run of runs) {
    try {
      const opened = await postJson("/api/runs", run.openPayload);
      const runId = opened.runId;
      const results = run.resultsPayload.results;
      for (let i = 0; i < results.length; i += BATCH_SIZE) {
        await postJson(`/api/runs/${runId}/results`, {
          results: results.slice(i, i + BATCH_SIZE),
        });
      }
      await postJson(`/api/runs/${runId}/complete`, run.completePayload);
      completed++;
    } catch (err) {
      failedCount++;
      if (failedCount <= 3) {
        process.stderr.write(`\n${pc.red("run failed")}: ${err.message}\n`);
      }
    }
  }
  stopSpin();
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (failedCount > 0) {
    console.log(
      `${pc.yellow(completed)} ok, ${pc.red(failedCount)} failed in ${elapsedSec}s`,
    );
  } else {
    console.log(`${pc.green("done")} (${completed} runs in ${elapsedSec}s)`);
  }

  if (failedCount > 0) {
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    process.exit(1);
  }
}

// ---------- Wrap up ----------

if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");

console.log("");
console.log(pc.green("✓ setup complete"));
console.log(`  ${pc.dim("dashboard:")} ${baseUrl}`);
console.log(`  ${pc.dim("sign in:  ")} demo@wrightful.local / demo1234`);
console.log(`  ${pc.dim("run:      ")} ${pc.cyan("pnpm dev")}`);
