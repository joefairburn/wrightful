import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { ulid } from "ulid";

const SLUG_RE = /^[a-z0-9-]+$/;

function usage() {
  console.error(
    "Usage: seed-api-key [label] --team <slug> --project <slug> [--local|--remote]",
  );
  console.error("");
  console.error(
    '  label       Human-readable label stored on the key (default: "initial").',
  );
  console.error("  --team      Slug of an existing team.");
  console.error("  --project   Slug of an existing project under that team.");
  console.error(
    "  --local     Target the local D1 (miniflare). Default: --remote.",
  );
  console.error("");
  console.error("Team and project must already exist. Create them via:");
  console.error("  1. Sign up in the dashboard.");
  console.error("  2. /admin/teams/new  → create a team.");
  console.error("  3. /admin/t/<team-slug>/projects/new  → create a project.");
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  const positional = [];
  const flags = { target: "--remote", team: "", project: "", help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--local" || a === "--remote") {
      flags.target = a;
    } else if (a === "--team") {
      flags.team = rest[++i];
    } else if (a.startsWith("--team=")) {
      flags.team = a.slice("--team=".length);
    } else if (a === "--project") {
      flags.project = rest[++i];
    } else if (a.startsWith("--project=")) {
      flags.project = a.slice("--project=".length);
    } else if (a === "--help" || a === "-h") {
      flags.help = true;
    } else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      usage();
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv);

if (flags.help) {
  usage();
  process.exit(0);
}

if (!flags.team || !flags.project) {
  console.error("error: --team and --project are required.");
  console.error("");
  usage();
  process.exit(1);
}

if (!SLUG_RE.test(flags.team) || !SLUG_RE.test(flags.project)) {
  console.error("error: slugs must match /^[a-z0-9-]+$/.");
  process.exit(1);
}

const label = positional[0] ?? "initial";
const dashboardDir = new URL("..", import.meta.url);

const escTeam = flags.team.replace(/'/g, "''");
const escProject = flags.project.replace(/'/g, "''");
const lookupSql = `SELECT p.id AS id FROM projects p JOIN teams t ON p.team_id = t.id WHERE t.slug = '${escTeam}' AND p.slug = '${escProject}' LIMIT 1;`;

const lookup = spawnSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "DB",
    flags.target,
    "--json",
    "--command",
    lookupSql,
  ],
  {
    cwd: dashboardDir,
  },
);

if (lookup.status !== 0) {
  process.stderr.write(lookup.stderr);
  process.exit(lookup.status ?? 1);
}

const lookupOut = lookup.stdout.toString();
const jsonMatch = lookupOut.match(/\[[\s\S]*\]/);
if (!jsonMatch) {
  console.error("Could not parse wrangler output:");
  console.error(lookupOut);
  process.exit(1);
}

const parsed = JSON.parse(jsonMatch[0]);
const rows = parsed[0]?.results ?? [];
if (rows.length === 0) {
  console.error(
    `error: no project found with team="${flags.team}" and project="${flags.project}".`,
  );
  console.error("");
  console.error("Create them in the dashboard first (see --help).");
  process.exit(1);
}

const projectId = rows[0].id;

const rand = Buffer.from(
  webcrypto.getRandomValues(new Uint8Array(16)),
).toString("hex");
const key = `wrf_live${rand}`;
const hashBuf = await webcrypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(key),
);
const hash = Array.from(new Uint8Array(hashBuf))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const prefix = key.slice(0, 8);
const id = ulid();

const escapedLabel = label.replace(/'/g, "''");
const insertSql = `INSERT INTO api_keys (id, project_id, label, key_hash, key_prefix, created_at) VALUES ('${id}', '${projectId}', '${escapedLabel}', '${hash}', '${prefix}', unixepoch());`;

const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", flags.target, "--command", insertSql],
  {
    stdio: "inherit",
    cwd: dashboardDir,
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("");
console.log(
  "API key created (save this now — the server only stores its hash):",
);
console.log(`  ${key}`);
console.log("");
console.log(`Scoped to team "${flags.team}" / project "${flags.project}".`);
