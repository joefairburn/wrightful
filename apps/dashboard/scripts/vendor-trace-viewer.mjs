#!/usr/bin/env node
// Vendor the official Playwright Trace Viewer bundle into `public/trace-viewer/`
// so we serve its service worker from our OWN origin. Our native React trace
// viewer (`src/trace-viewer/`) drives that SW through a hidden bridge iframe
// (`bridge.html`), so a test's trace bytes replay in-dashboard and never bounce
// out to the public trace.playwright.dev. Playwright's own HTML shells (its
// standalone SPA + snapshot popout) are a separate matter — see
// SCRIPTED_SHELLS below; they only ship on a cookieless viewer origin.
// The bundle ships inside `playwright-core` as a
// position-independent Vite build (relative asset refs, a scope-relative service
// worker), so a plain recursive copy into a subdir Just Works (see the worklog
// + plan for why no rewrites/scope headers are needed).
//
// Runs in the dev/build/deploy pre-hooks. The output dir is gitignored: it's a
// generated artifact, pinned to the installed playwright-core version and
// regenerated whenever that version changes. Fails LOUDLY if the source layout
// moves on a Playwright upgrade so a silent breakage can't ship.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;
const TARGET = at("public/trace-viewer");
const STAMP = `${TARGET}/.vendored-version`;

// Playwright's own HTML shells. Each frames a DOM snapshot with a HARDCODED
// `sandbox="allow-same-origin allow-scripts"` we cannot override: index.html's
// SPA sets it on its two snapshot iframes, snapshot.html on its single one.
// Trace bytes are attacker-craftable, so on the dashboard's session origin that
// is a stored-XSS path — exactly what `snapshotSandbox` exists to close for our
// OWN embedded viewer.
//
// They are only safe on a cookieless viewer origin, so when none is configured
// we do not ship them at all. That is deliberately a BUILD-time decision: these
// are static assets, and static assets are served without running the Hono
// middleware (verified against a production `vp preview`: a middleware early
// return never fires for them, while a path with no file 404s). So "not on disk"
// is the only enforceable answer — runtime gating would be theatre.
//
// Our own viewer needs none of them: it registers the service worker from
// bridge.html and points its iframes at the SW-synthesized
// /trace-viewer/snapshot/*. The popout (snapshot.html) and the MCP
// `traceViewerUrl` (index.html) are gated on the same configured-origin check,
// so nothing ever links a file we pruned.
const SCRIPTED_SHELLS = ["index.html", "snapshot.html", "uiMode.html"];

// Resolve the viewer origin the way VITE does when it inlines the value into the
// client bundle (`.env`, `.env.local`, prefixed `process.env`) — reading only
// `process.env` here would miss a self-hoster's `.env.local` and prune the
// shells out from under a deployment that HAS configured isolation.
const viewerOrigin = (
  loadEnv("production", root, "VITE_").VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN ?? ""
).trim();
const shellsServed = viewerOrigin !== "";
// Part of the stamp: toggling isolation must invalidate the vendored output even
// when the playwright-core version is unchanged.
const stampValue = shellsServed ? "with-shells" : "no-shells";

// Files that MUST exist in the SOURCE bundle. Checked as a layout canary even
// for the shells we may not ship, so a Playwright reshuffle still fails loudly:
//   index.html   — the standalone stock SPA: the full-fidelity viewer on a
//                  cookieless viewer origin (the MCP `traceViewerUrl`)
//   sw.bundle.js  — the snapshot-serving service worker our bridge registers
//   snapshot.html — the popout target on a cookieless viewer origin. NOT used by
//                  our own viewer or the SW (neither references it).
const REQUIRED = ["index.html", "sw.bundle.js", "snapshot.html"];

function fail(msg) {
  console.error(pc.red(`[vendor-trace-viewer] ${msg}`));
  process.exit(1);
}

const packagePath = fileURLToPath(
  import.meta.resolve("playwright-core/package.json"),
);
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
if (typeof packageJson.version !== "string") {
  fail(`${packagePath} does not contain a string version.`);
}
const coreDir = dirname(packagePath);
const version = packageJson.version;
const src = `${coreDir}/lib/vite/traceViewer`;

if (!existsSync(src)) {
  fail(
    `trace viewer bundle not found at ${src}. Playwright's layout likely changed in v${version} — update this script.`,
  );
}
for (const f of REQUIRED) {
  if (!existsSync(`${src}/${f}`)) {
    fail(
      `expected ${f} in the trace viewer bundle (v${version}) but it's missing. Playwright's layout changed — update this script.`,
    );
  }
}

// Beyond "the files exist": the snapshot pane depends on a specific STRING
// inside sw.bundle.js. Playwright renders every snapshot behind a
// `visibility: hidden` guard stylesheet that its inline bootstrap lifts on
// load, but same-origin snapshot iframes run without `allow-scripts` (uploaded
// trace bytes are attacker-craftable), so the bootstrap is blocked and
// `prepareScriptlessSnapshot` lifts the guard from the parent by exact text. A
// Playwright bump that rewords it breaks that match and blanks every replay
// with nothing else failing — and `deploy:cf` runs this script but NOT the test
// suite, so checking it only in vitest would still let a self-hoster ship the
// blank pane. Read the expected text out of the module that consumes it, so
// there is exactly one copy of the literal.
const GUARD_MODULE = at("src/trace-viewer/components/scriptless-snapshot.ts");
const guardMatch =
  /^export const SNAPSHOT_VISIBILITY_GUARD_CSS =\s*"((?:[^"\\]|\\.)*)";$/m.exec(
    existsSync(GUARD_MODULE) ? readFileSync(GUARD_MODULE, "utf8") : "",
  );
if (!guardMatch) {
  fail(
    `could not read SNAPSHOT_VISIBILITY_GUARD_CSS from ${GUARD_MODULE}. If that export moved or changed shape, update this check — it is what keeps a Playwright bump from silently blanking the replay pane.`,
  );
}
// The renderer builds each snapshot as `[guard, bootstrap].join("")`, so the
// guard leading that array literal is what puts it first in the parsed
// document — which is the position `prepareScriptlessSnapshot` relies on.
const guardStyle = `<style>${guardMatch[1]}</style>`;
if (
  !readFileSync(`${src}/sw.bundle.js`, "utf8").includes(`["${guardStyle}",`)
) {
  fail(
    `playwright-core v${version} no longer opens its rendered snapshots with ${guardStyle}.\n` +
      `  Same-origin snapshot iframes run without \`allow-scripts\`, so\n` +
      `  src/trace-viewer/components/scriptless-snapshot.ts is what makes their DOM visible.\n` +
      `  Re-derive SNAPSHOT_VISIBILITY_GUARD_CSS from this version's snapshot renderer\n` +
      `  (and check it is still emitted first), or replay renders a blank pane.`,
  );
}

// Our custom viewer's SW bridge (see src/trace-viewer/bridge.html) must live
// INSIDE the /trace-viewer/ service-worker scope, i.e. inside this generated
// dir — so it's copied here on every run (cheap, and unlike the playwright
// bundle it changes with OUR source, not with the pinned version).
const BRIDGE_SRC = at("src/trace-viewer/bridge.html");

function copyBridge() {
  if (!existsSync(BRIDGE_SRC)) {
    fail(`bridge source not found at ${BRIDGE_SRC}.`);
  }
  cpSync(BRIDGE_SRC, `${TARGET}/bridge.html`);
}

// Idempotent: skip the playwright copy when the vendored bundle already matches
// the installed version AND the same shell policy (keeps `predev` snappy on
// every boot, while toggling the viewer origin still forces a re-vendor).
const stamp = `${version} ${stampValue}`;
if (existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === stamp) {
  copyBridge();
  console.log(
    pc.dim(
      `[vendor-trace-viewer] up to date (playwright-core ${version}, ${stampValue})`,
    ),
  );
  process.exit(0);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
cpSync(src, TARGET, { recursive: true });
copyBridge();

// Prune AFTER the copy so the source-layout canary above still sees them.
if (!shellsServed) {
  for (const shell of SCRIPTED_SHELLS) {
    rmSync(`${TARGET}/${shell}`, { force: true });
  }
}
writeFileSync(STAMP, `${stamp}\n`);
console.log(
  pc.green(
    `[vendor-trace-viewer] vendored playwright-core ${version} → public/trace-viewer/`,
  ),
);
console.log(
  shellsServed
    ? pc.dim(
        `[vendor-trace-viewer] serving Playwright's scripted shells (${SCRIPTED_SHELLS.join(", ")}) — trace-viewer origin is ${viewerOrigin}`,
      )
    : pc.dim(
        `[vendor-trace-viewer] pruned Playwright's scripted shells (${SCRIPTED_SHELLS.join(", ")}) — no VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN, so snapshot scripts must not run on the session origin`,
      ),
);
