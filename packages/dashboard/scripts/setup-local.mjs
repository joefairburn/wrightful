import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { startSpinner } from "./lib/spinner.mjs";

/**
 * Try to bind `port` on `host`. Resolves with the actual port (OS-assigned
 * when port=0), rejects on any listen error.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<number>}
 */
function tryBind(port, host) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    const cb = () => {
      const addr = srv.address();
      const actual = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(actual));
    };
    if (host) srv.listen(port, host, cb);
    else srv.listen(port, cb);
  });
}

/**
 * Try to bind `preferred` on both IPv4 and IPv6 loopback (because vite
 * resolves `localhost` differently per OS — macOS tends to prefer `::1`).
 * If either family is already taken, fall back to an OS-assigned free port.
 *
 * @param {number} preferred
 * @returns {Promise<number>}
 */
async function pickPort(preferred) {
  for (const host of ["127.0.0.1", "::1"]) {
    try {
      await tryBind(preferred, host);
    } catch (err) {
      if (err.code === "EADDRINUSE") {
        return tryBind(0);
      }
      // IPv6 may be unavailable on some systems (EADDRNOTAVAIL) — not fatal,
      // keep going with the preferred port.
      if (err.code !== "EADDRNOTAVAIL") throw err;
    }
  }
  return preferred;
}

const dashboardDir = new URL("..", import.meta.url);
const envUrl = new URL(".dev.vars", dashboardDir);
const exampleUrl = new URL(".dev.vars.example", dashboardDir);
const seedConfigUrl = new URL(".dev.vars.seed.json", dashboardDir);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

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

if (existsSync(envUrl)) {
  console.log(
    `${pc.dim("›")} ${"checking .dev.vars…".padEnd(LABEL_WIDTH)} ${pc.dim("already present")}`,
  );
} else {
  const template = readFileSync(exampleUrl, "utf8");
  const secret = Buffer.from(
    webcrypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  writeFileSync(
    envUrl,
    template.replace("replace-me-with-32-plus-char-random-secret", secret),
  );
  console.log(
    `${pc.dim("›")} ${"creating .dev.vars…".padEnd(LABEL_WIDTH)} ${pc.green("done")}`,
  );
}

// ---------- D1 migrations ----------

// Pre-launch, we squash the initial migration rather than stacking new ones.
// That means a dev's existing local D1 may have an older schema with no way
// to catch up via `wrangler d1 migrations apply` (which treats 0000 as
// already-applied). Detect that case by probing for canary objects and wipe
// the local D1 state so the fresh migration runs cleanly. `.wrangler` also
// holds KV/R2 emulator state — wiping is fine for local dev.
const d1StateDir = new URL("../.wrangler/state/v3/d1", import.meta.url);

function runProbe(command) {
  return spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--json",
      "--command",
      command,
    ],
    {
      cwd: fileURLToPath(dashboardDir),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
}

function wipeLocalD1() {
  console.log(
    `${pc.dim("›")} ${"schema out of date…".padEnd(LABEL_WIDTH)} ${pc.yellow("wiping local D1")}`,
  );
  rmSync(d1StateDir, { recursive: true, force: true });
  const seedPath = fileURLToPath(seedConfigUrl);
  if (existsSync(seedPath)) rmSync(seedPath);
}

if (existsSync(d1StateDir)) {
  const colsProbe = runProbe(
    "SELECT json_group_array(name) AS cols FROM pragma_table_info('runs');",
  );
  if (colsProbe.status === 0) {
    // wrangler --json emits `"cols": "[\"id\",\"project_id\",...]"` — a
    // JSON-in-JSON string. Simple substring checks on the escaped form are
    // enough: `\"id\"` appears only when the runs table exists at all,
    // `\"committed\"` only when the column is present.
    const runsExists = colsProbe.stdout.includes('\\"id\\"');
    const hasCommitted = colsProbe.stdout.includes('\\"committed\\"');
    if (runsExists && !hasCommitted) {
      wipeLocalD1();
    } else if (runsExists) {
      // runs is initialized — also check the committed_runs view exists.
      // Older squashed 0000s created runs.committed but not the view; wrangler
      // won't re-run 0000, so we'd end up with queries against a missing view.
      const viewProbe = runProbe(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'committed_runs';",
      );
      if (
        viewProbe.status === 0 &&
        !viewProbe.stdout.includes("committed_runs")
      ) {
        wipeLocalD1();
      }
    }
  }
}

await stage("applying D1 migrations…", "npx", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
]);

// ---------- Demo user / team / project / api key ----------

const hadSeed = existsSync(seedConfigUrl);
await stage(
  hadSeed ? "checking demo account…" : "seeding demo account…",
  "node",
  ["scripts/seed-demo.mjs"],
  { env: { ...process.env, WRIGHTFUL_QUIET: "1" } },
);

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
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "wrightful-seed-1";
})();

const skipFixtures = process.argv.includes("--no-fixtures") || withHistory;

if (!skipFixtures) {
  if (!existsSync(seedConfigUrl)) {
    console.error(
      pc.red(
        "\n.dev.vars.seed.json is missing but the demo user already exists in D1.",
      ),
    );
    console.error(
      pc.dim(
        "The plaintext API key can't be recovered from D1. Wipe local D1 and re-run:",
      ),
    );
    console.error(
      pc.dim("  rm -rf packages/dashboard/.wrangler && pnpm setup:local"),
    );
    process.exit(1);
  }
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );

  let baseUrl = seedConfig.url;

  async function probe(url) {
    try {
      // Hit the streaming ingest endpoint with an auth header + empty body.
      // 400 = server up, auth accepted, body invalid (expected).
      // 401 = auth rejected (bad API key).
      const res = await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seedConfig.apiKey}`,
          "X-Wrightful-Version": "3",
        },
        body: "{}",
      });
      return res.status;
    } catch {
      return null;
    }
  }

  const initialProbe = await probe(baseUrl);
  const alreadyUp = initialProbe === 400;

  let devServer = null;
  let devServerExited = false;
  if (!alreadyUp) {
    // If 5173 is held by anything else (sibling workspace's dev server, a
    // stray process, etc.), fall back to a free port. Fixture upload hits
    // /api/runs with a Bearer key, so the URL mismatch vs Better Auth's
    // pinned WRIGHTFUL_PUBLIC_URL doesn't matter for this window.
    const port = await pickPort(5173);
    if (port !== 5173) {
      baseUrl = `http://localhost:${port}`;
      console.log(
        `${pc.dim("›")} ${"port 5173 busy…".padEnd(LABEL_WIDTH)} ${pc.dim(`using ${port} for fixture upload`)}`,
      );
    }

    const stopDevSpinner = startSpinner(stageLabel("starting dev server…"));
    // `pnpm exec` resolves `vite` from the dashboard package's bin directory
    // reliably across pnpm workspace setups. Raw `npx vite` can misfire when
    // the shim isn't on the caller's PATH.
    devServer = spawn(
      "pnpm",
      [
        "--filter",
        "@wrightful/dashboard",
        "exec",
        "vite",
        "dev",
        "--port",
        String(port),
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let devOutput = "";
    devServer.stdout?.on("data", (d) => (devOutput += d.toString()));
    devServer.stderr?.on("data", (d) => (devOutput += d.toString()));
    devServer.on("exit", () => {
      devServerExited = true;
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

    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (devServerExited) {
        stopDevSpinner();
        console.log(pc.red("failed"));
        console.error(pc.red("\ndev server exited during startup — aborting"));
        if (devOutput) process.stderr.write(`${devOutput}\n`);
        process.exit(1);
      }
      if ((await probe(baseUrl)) === 400) {
        ready = true;
        break;
      }
    }
    stopDevSpinner();
    if (!ready) {
      console.log(pc.red("failed"));
      console.error(
        pc.red("\ndev server did not become ready within 90s — aborting"),
      );
      process.exit(1);
    }
    console.log(pc.green("ready"));
  } else {
    console.log(
      `${pc.dim("›")} ${"dev server…".padEnd(LABEL_WIDTH)} ${pc.dim("already running")}`,
    );
  }

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
    },
  });

  if (devServer && !devServer.killed) devServer.kill("SIGTERM");

  if (fixtures.status !== 0) {
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
    process.exit(1);
  }
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );
  const { ensureDashboardRunning } = await import("./lib/dev-server.mjs");
  const { generateHistory } = await import("./seed/generator.mjs");

  const { baseUrl: historyBaseUrl, spawned } = await ensureDashboardRunning(
    seedConfig,
    { labelWidth: LABEL_WIDTH },
  );

  console.log(
    `\n${pc.bold(`generating ${historyMonths} months of history (seed=${historySeed})`)}`,
  );
  const { runs } = generateHistory({
    months: historyMonths,
    seed: historySeed,
  });
  console.log(
    `${pc.dim("›")} ${"runs to ingest…".padEnd(LABEL_WIDTH)} ${pc.cyan(runs.length)}`,
  );

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${seedConfig.apiKey}`,
    "X-Wrightful-Version": "3",
  };
  const BATCH_SIZE = 50;
  const postJson = async (path, body) => {
    const res = await fetch(`${historyBaseUrl}${path}`, {
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

  if (spawned && !spawned.killed) spawned.kill("SIGTERM");
  if (failedCount > 0) process.exit(1);
}

console.log("");
console.log(pc.green("✓ setup complete"));
console.log(`  ${pc.dim("dashboard:")} http://localhost:5173`);
console.log(`  ${pc.dim("sign in:  ")} demo@wrightful.local / demo1234`);
console.log(`  ${pc.dim("run:      ")} ${pc.cyan("pnpm dev")}`);
