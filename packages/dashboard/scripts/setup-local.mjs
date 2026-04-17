import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";

const dashboardDir = new URL("..", import.meta.url);
const envUrl = new URL(".dev.vars", dashboardDir);
const exampleUrl = new URL(".dev.vars.example", dashboardDir);

if (existsSync(envUrl)) {
  console.log("packages/dashboard/.dev.vars already exists — skipping");
} else {
  const template = readFileSync(exampleUrl, "utf8");
  const secret = Buffer.from(
    webcrypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  const filled = template.replace(
    "replace-me-with-32-plus-char-random-secret",
    secret,
  );
  writeFileSync(envUrl, filled);
  console.log(
    "created packages/dashboard/.dev.vars with a generated BETTER_AUTH_SECRET",
  );
}

console.log("applying D1 migrations (local)...");
const migrate = spawnSync(
  "npx",
  ["wrangler", "d1", "migrations", "apply", "DB", "--local"],
  {
    stdio: "inherit",
    cwd: dashboardDir,
  },
);
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

console.log("");
console.log("seeding demo user/team/project/api-key...");
const seed = spawnSync("node", ["scripts/seed-demo.mjs"], {
  stdio: "inherit",
  cwd: dashboardDir,
});
if (seed.status !== 0) {
  process.exit(seed.status ?? 1);
}

console.log("");
console.log("done — next steps:");
console.log("  1. pnpm dev               # start dashboard on :5173");
console.log("  2. pnpm fixtures:generate # upload example runs (optional)");
console.log("     sign in: demo@wrightful.local / demo1234");
