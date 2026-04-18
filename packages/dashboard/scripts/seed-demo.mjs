// Bootstraps a demo user + team + project + API key in the local D1 so a fresh
// `pnpm setup:local` has something to sign into. Idempotent: safe to re-run.
// Writes the resolved URL + API key to `.dev.vars.seed.json` so the fixture
// uploader can find them without the user copy-pasting.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { ulid } from "ulid";

const DEMO_EMAIL = "demo@wrightful.local";
const DEMO_PASSWORD = "demo1234";
const DEMO_NAME = "Demo User";
const TEAM_SLUG = "demo";
const TEAM_NAME = "Demo Team";
const PROJECT_SLUG = "playwright";
const PROJECT_NAME = "Playwright Demo";
const DASHBOARD_URL = "http://localhost:5173";

const dashboardDir = new URL("..", import.meta.url);
const seedOutputPath = new URL(".dev.vars.seed.json", dashboardDir).pathname;
const QUIET = process.env.WRIGHTFUL_QUIET === "1";
const log = (...args) => {
  if (!QUIET) console.log(...args);
};

function d1(sql, { json = false } = {}) {
  const res = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      ...(json ? ["--json"] : []),
      "--command",
      sql,
    ],
    { cwd: dashboardDir, encoding: "utf8" },
  );
  if (res.status !== 0) {
    process.stderr.write(res.stderr ?? "");
    process.exit(res.status ?? 1);
  }
  return res.stdout;
}

function queryFirst(sql) {
  const out = d1(sql, { json: true });
  const match = out.match(/\[[\s\S]*\]/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  const rows = parsed[0]?.results ?? [];
  return rows[0] ?? null;
}

const existing = queryFirst(
  `SELECT id FROM user WHERE email = '${DEMO_EMAIL}' LIMIT 1;`,
);

if (existing) {
  log(`demo user already exists (id=${existing.id}) — skipping seed`);

  // Still (re)write .dev.vars.seed.json if an API key row exists so the
  // fixture uploader keeps working after repo checkouts. We can only recover
  // the API key value when it was written to disk before; if the seed file
  // is gone the user must rotate the key via the UI.
  if (!existsSync(seedOutputPath)) {
    log(`note: .dev.vars.seed.json missing. To re-seed: wipe D1 + re-run.`);
  }
  process.exit(0);
}

// ---------- Create rows ----------

const userId = ulid();
const accountId = ulid();
const teamId = ulid();
const membershipId = ulid();
const projectId = ulid();
const apiKeyRowId = ulid();

const rand = Buffer.from(
  webcrypto.getRandomValues(new Uint8Array(16)),
).toString("hex");
const apiKey = `wrf_live${rand}`;
const apiKeyHashBuf = await webcrypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(apiKey),
);
const apiKeyHash = Array.from(new Uint8Array(apiKeyHashBuf))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const apiKeyPrefix = apiKey.slice(0, 8);

const passwordHash = await hashPassword(DEMO_PASSWORD);

function esc(s) {
  return s.replace(/'/g, "''");
}

const nowMs = Date.now();
const nowS = Math.floor(nowMs / 1000);

// `timestamp` mode = seconds; `timestamp_ms` mode = ms. See src/db/schema.ts.
const stmts = [
  `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES ('${userId}', '${esc(DEMO_NAME)}', '${esc(DEMO_EMAIL)}', 1, ${nowMs}, ${nowMs});`,
  `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
     VALUES ('${accountId}', '${userId}', 'credential', '${userId}', '${esc(passwordHash)}', ${nowMs}, ${nowMs});`,
  `INSERT INTO teams (id, slug, name, created_at)
     VALUES ('${teamId}', '${TEAM_SLUG}', '${esc(TEAM_NAME)}', ${nowS});`,
  `INSERT INTO memberships (id, user_id, team_id, role, created_at)
     VALUES ('${membershipId}', '${userId}', '${teamId}', 'owner', ${nowS});`,
  `INSERT INTO projects (id, team_id, slug, name, created_at)
     VALUES ('${projectId}', '${teamId}', '${PROJECT_SLUG}', '${esc(PROJECT_NAME)}', ${nowS});`,
  `INSERT INTO api_keys (id, project_id, label, key_hash, key_prefix, created_at)
     VALUES ('${apiKeyRowId}', '${projectId}', 'fixtures', '${apiKeyHash}', '${apiKeyPrefix}', ${nowS});`,
];

for (const stmt of stmts) {
  d1(stmt);
}

writeFileSync(
  seedOutputPath,
  JSON.stringify(
    {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      url: DASHBOARD_URL,
      teamSlug: TEAM_SLUG,
      projectSlug: PROJECT_SLUG,
      apiKey,
    },
    null,
    2,
  ) + "\n",
);

log("");
log("seeded demo account:");
log(`  email:    ${DEMO_EMAIL}`);
log(`  password: ${DEMO_PASSWORD}`);
log(`  team:     ${TEAM_SLUG}`);
log(`  project:  ${PROJECT_SLUG}`);
log(`  api key:  ${apiKey}`);
log(`  (also written to packages/dashboard/.dev.vars.seed.json)`);
