// Shared helpers for setup-local.mjs / seed-history.mjs: probing the local
// dashboard, picking a free port, and spawning `vite dev` on demand. Kept
// thin — no orchestration opinions, just the primitives.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { startSpinner } from "./spinner.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Try to bind `port` on `host`. Resolves with the actual port (OS-assigned
 * when port=0), rejects on any listen error.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function tryBind(port, host) {
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
export async function pickPort(preferred) {
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

/**
 * Hit the streaming ingest endpoint with an auth header + empty body.
 * 400 = server up, auth accepted, body invalid (expected signal that our
 * dashboard is live on this URL).
 * 401 = auth rejected (bad API key — caller surfaces a clearer error).
 * anything else / null = not our server / not ready.
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @returns {Promise<number | null>}
 */
export async function probeDashboard(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Wrightful-Version": "3",
      },
      body: "{}",
    });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Ensure a dashboard dev server is reachable at `seed.url` (or a free
 * fallback port). If nothing is listening, spawns `vite dev` in the repo
 * root and polls for readiness for up to 90s. The returned `baseUrl`
 * reflects whatever port we actually used — callers must pass it through
 * to their HTTP work.
 *
 * Registers exit / SIGINT / SIGTERM handlers to kill the spawned server
 * so Ctrl-C doesn't orphan a miniflare process.
 *
 * @param {{ url: string, apiKey: string }} seed
 * @param {{ labelWidth?: number }} [opts]
 * @returns {Promise<{ baseUrl: string, spawned: any }>}
 */
export async function ensureDashboardRunning(seed, opts = {}) {
  const labelWidth = opts.labelWidth ?? 34;
  const stageLabel = (label) => `${pc.dim("›")} ${label.padEnd(labelWidth)} `;

  let baseUrl = seed.url;
  const initial = await probeDashboard(baseUrl, seed.apiKey);
  if (initial === 400) {
    console.log(
      `${pc.dim("›")} ${"dev server…".padEnd(labelWidth)} ${pc.dim("already running")}`,
    );
    return { baseUrl, spawned: null };
  }
  if (initial === 401) {
    console.error(
      pc.red(
        "dashboard rejected the demo API key. Wipe D1 and re-run `pnpm setup:local`.",
      ),
    );
    process.exit(1);
  }

  const port = await pickPort(5173);
  if (port !== 5173) {
    baseUrl = `http://localhost:${port}`;
    console.log(
      `${pc.dim("›")} ${"port 5173 busy…".padEnd(labelWidth)} ${pc.dim(`using ${port}`)}`,
    );
  }

  const stopSpinner = startSpinner(stageLabel("starting dev server…"));
  const spawned = spawn(
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
  let output = "";
  let exited = false;
  spawned.stdout?.on("data", (d) => (output += d.toString()));
  spawned.stderr?.on("data", (d) => (output += d.toString()));
  spawned.on("exit", () => {
    exited = true;
  });
  const kill = () => {
    if (spawned && !spawned.killed) spawned.kill("SIGTERM");
  };
  process.on("exit", kill);
  process.on("SIGINT", () => {
    kill();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(143);
  });

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) {
      stopSpinner();
      console.log(pc.red("failed"));
      console.error(pc.red("\ndev server exited during startup — aborting"));
      if (output) process.stderr.write(`${output}\n`);
      process.exit(1);
    }
    if ((await probeDashboard(baseUrl, seed.apiKey)) === 400) {
      ready = true;
      break;
    }
  }
  stopSpinner();
  if (!ready) {
    console.log(pc.red("failed"));
    console.error(
      pc.red("\ndev server did not become ready within 90s — aborting"),
    );
    process.exit(1);
  }
  console.log(pc.green("ready"));
  return { baseUrl, spawned };
}
