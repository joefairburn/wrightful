#!/usr/bin/env node
// Hits /api/admin/migrate on the deployed worker to apply pending control-D1
// migrations. Used as the post-deploy step in `deploy:remote`. Reads
// WRIGHTFUL_PUBLIC_URL + MIGRATE_SECRET from env (set in Cloudflare Builds
// build vars / locally in your shell).

const url = process.env.WRIGHTFUL_PUBLIC_URL;
const secret = process.env.MIGRATE_SECRET;

if (!url) {
  console.error("WRIGHTFUL_PUBLIC_URL is required (the deployed worker URL).");
  process.exit(1);
}
if (!secret) {
  console.error("MIGRATE_SECRET is required (must match the Worker secret).");
  process.exit(1);
}

const endpoint = `${url.replace(/\/$/, "")}/api/admin/migrate`;
console.log(`POST ${endpoint}`);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
let res;
let body;
try {
  res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  });
  body = await res.text();
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
    console.error("Migration call timed out after 60s.");
  } else {
    console.error("Migration call failed:", err);
  }
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

if (!res.ok) {
  console.error(`migrate failed (${res.status}): ${body}`);
  process.exit(1);
}
console.log(body);
