#!/usr/bin/env node
// Staged deploy with migrate-aware rollback. Pattern:
//
//   1. `wrangler versions upload` — uploads a new Worker version. It is NOT
//      promoted; the previously-deployed version keeps serving 100% of
//      traffic. Provisioning of D1 / R2 / DOs happens here on first deploy.
//   2. POST /api/admin/migrate against the new version's preview URL. The
//      migrate handler runs `Kysely.Migrator` against D1, applying any
//      pending migrations under the new code's migration list.
//   3. `wrangler versions deploy <id>` — promotes the uploaded version to
//      100% traffic. Only happens if (2) succeeded.
//
// On any failure: bail. The new version remains uploaded but dormant; the
// old version keeps serving traffic. No user-visible regression.
//
// Caveats:
// - D1 has no transactions in its public API, so a migration that fails
//   midway leaves partial schema. Old code keeps serving but may 500 on
//   paths that touch the partially-applied tables. Discipline:
//   forward-only / additive migrations.
// - Preview URLs require the worker to be on a workers.dev subdomain (the
//   default). Custom-domain-only setups would need a different routing
//   strategy.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = resolve(fileURLToPath(import.meta.url), "../..");

const migrateSecret = process.env.MIGRATE_SECRET;
if (!migrateSecret) {
  console.error("MIGRATE_SECRET is required (must match the Worker secret).");
  process.exit(1);
}

function wrangler(args, opts = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: dashboardRoot,
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

// ---------- 1. Upload (no traffic shift) ----------

const outDir = mkdtempSync(join(tmpdir(), "wrightful-deploy-"));
const outFile = join(outDir, "wrangler.ndjson");
console.log("→ wrangler versions upload");
wrangler(["versions", "upload"], {
  env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile },
});

// Wrangler 4 emits ND-JSON events to WRANGLER_OUTPUT_FILE_PATH. The
// `version-upload` event carries the version id + preview URL.
const events = readFileSync(outFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const uploadEvent = events.find((e) => e.type === "version-upload");
if (!uploadEvent) {
  console.error(
    "Could not find `version-upload` event in wrangler output. Events seen:",
  );
  console.error(events.map((e) => e.type).join(", "));
  process.exit(1);
}

const versionId = uploadEvent.version_id;
const previewUrl = uploadEvent.preview_url;
if (!versionId || !previewUrl) {
  console.error("Upload event missing version_id or preview_url:", uploadEvent);
  process.exit(1);
}

console.log(`Uploaded version ${versionId}`);
console.log(`Preview URL: ${previewUrl}`);

// ---------- 2. Migrate (against the NEW version's preview URL) ----------

const endpoint = `${previewUrl.replace(/\/$/, "")}/api/admin/migrate`;
console.log(`→ POST ${endpoint}`);

// 60s ceiling: enough for any reasonable schema migration (D1 round trips
// against a small control DB are sub-second), short enough that a network
// blip fails the deploy in a minute instead of hanging until CF Builds'
// 90-minute build timeout kicks in. Data-backfill migrations should not
// live in this hook — run them as out-of-band scripts.
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
let res;
let body;
try {
  res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${migrateSecret}` },
    signal: controller.signal,
  });
  body = await res.text();
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
    console.error(
      `Migration call timed out after 60s. The new version (${versionId}) ` +
        "remains uploaded but unpromoted; old version still serving traffic.",
    );
  } else {
    console.error("Migration call failed:", err);
  }
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

if (!res.ok) {
  console.error(`Migration failed (${res.status}): ${body}`);
  console.error(
    `\nThe new version (${versionId}) has been uploaded but NOT promoted. ` +
      `Old code is still serving traffic. Inspect the failure, fix the ` +
      `migration, and redeploy. If schema is partially applied, see ` +
      `SELF-HOSTING.md "Recovering from a failed migration".`,
  );
  process.exit(1);
}
console.log(body);

// ---------- 3. Promote ----------

console.log(`→ wrangler versions deploy ${versionId}@100%`);
wrangler(["versions", "deploy", `${versionId}@100%`, "--yes"]);

console.log("\nDeploy complete.");
