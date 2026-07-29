#!/usr/bin/env node
// Vendor the official Playwright Trace Viewer bundle into `public/trace-viewer/`
// so we serve its service worker + snapshot shell (and the standalone SPA) from
// our OWN origin. Our native React trace viewer (`src/trace-viewer/`) drives
// that SW through a hidden bridge iframe (`bridge.html`), so a test's trace
// bytes replay in-dashboard and never bounce out to the public
// trace.playwright.dev. The bundle ships inside `playwright-core` as a
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

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;
const TARGET = at("public/trace-viewer");
const STAMP = `${TARGET}/.vendored-version`;

// Files that MUST exist in the source bundle — our replay surface depends on each:
//   index.html   — the standalone SPA, served for the "open in the self-hosted
//                  viewer" link (the MCP `traceViewerUrl`) + a layout canary
//   sw.bundle.js  — the snapshot-serving service worker our bridge registers
//   snapshot.html — the nested snapshot frame the SW hydrates
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

// Idempotent: skip the playwright copy when the vendored bundle already
// matches the installed version (keeps `predev` snappy on every boot).
if (existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === version) {
  copyBridge();
  console.log(
    pc.dim(`[vendor-trace-viewer] up to date (playwright-core ${version})`),
  );
  process.exit(0);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
cpSync(src, TARGET, { recursive: true });
copyBridge();
writeFileSync(STAMP, `${version}\n`);
console.log(
  pc.green(
    `[vendor-trace-viewer] vendored playwright-core ${version} → public/trace-viewer/`,
  ),
);
