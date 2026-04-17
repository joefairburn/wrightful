import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { ulid } from "ulid";

const label = process.argv[2] ?? "initial";
const target = process.argv[3] === "--local" ? "--local" : "--remote";

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
const sql = `INSERT INTO api_keys (id, label, key_hash, key_prefix, created_at) VALUES ('${id}', '${escapedLabel}', '${hash}', '${prefix}', unixepoch());`;

const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", target, "--command", sql],
  {
    stdio: "inherit",
    cwd: new URL("..", import.meta.url),
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
