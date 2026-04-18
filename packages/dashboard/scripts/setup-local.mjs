import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { startSpinner } from "./lib/spinner.mjs";

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

const skipFixtures = process.argv.includes("--no-fixtures");

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

  async function probe() {
    try {
      const res = await fetch(`${seedConfig.url}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seedConfig.apiKey}`,
        },
        body: "{}",
      });
      return res.status;
    } catch {
      return null;
    }
  }

  const initialProbe = await probe();
  if (initialProbe === 401) {
    console.error(
      pc.red(
        `\nsomething is already listening on ${seedConfig.url} but does not recognise our demo API key.`,
      ),
    );
    console.error(
      pc.dim(
        "Likely a dev server from another workspace. Stop it (or free port 5173) and retry.",
      ),
    );
    process.exit(1);
  }
  const alreadyUp = initialProbe === 400;

  let devServer = null;
  let devServerExited = false;
  if (!alreadyUp) {
    const stopDevSpinner = startSpinner(stageLabel("starting dev server…"));
    devServer = spawn("pnpm", ["--filter", "@wrightful/dashboard", "dev"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
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
        console.error(
          pc.red(
            "\ndev server exited during startup. Most likely port 5173 is taken (see `lsof -iTCP:5173 -sTCP:LISTEN`) — strictPort is on.",
          ),
        );
        process.exit(1);
      }
      if ((await probe()) === 400) {
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
  const fixtures = spawnSync("node", ["scripts/upload-fixtures.mjs"], {
    stdio: "inherit",
    cwd: dashboardDir,
    env: { ...process.env, WRIGHTFUL_QUIET: "1" },
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

console.log("");
console.log(pc.green("✓ setup complete"));
console.log(`  ${pc.dim("dashboard:")} http://localhost:5173`);
console.log(`  ${pc.dim("sign in:  ")} demo@wrightful.local / demo1234`);
console.log(`  ${pc.dim("run:      ")} ${pc.cyan("pnpm dev")}`);
