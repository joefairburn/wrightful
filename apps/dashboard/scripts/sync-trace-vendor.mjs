#!/usr/bin/env node
// Sync `src/trace-viewer/vendor/` — faithful copies of upstream Playwright
// trace-model source — from the microsoft/playwright GitHub tag that matches
// the INSTALLED playwright-core version.
//
// Why this exists: `src/trace-viewer/vendor/*.ts` are hand-adapted copies of
// upstream files (see each file's VENDOR-PROVENANCE comment for its exact
// origin + import-rewrite rules). `scripts/vendor-trace-viewer.mjs` copies
// the COMPILED trace-viewer bundle (the runtime engine) straight out of
// node_modules on every dev/build; this script instead re-pulls the TS
// SOURCE of the small trace-model slice we hand-maintain, so a playwright-core
// bump can be reconciled with a command instead of a manual line-by-line diff.
// `src/__tests__/trace-viewer-vendor.test.ts` fails the moment installed
// playwright-core moves past `vendor/version.ts`'s pinned version — that's
// the trigger to run this script.
//
// Design: each vendored file's local header (license + optional
// oxlint-disable + VENDOR-PROVENANCE comment) is LOCAL-ONLY scaffolding not
// present verbatim upstream (well, the license text is, but we don't trust
// two copies of it to stay byte-identical — we keep OUR copy authoritative
// since it also carries the provenance/adaptation notes). So on every sync we:
//   1. Split the CURRENT local file at its first `import`/`export`/`const`
//      line — everything before that is "header", kept as-is except for
//      `tag vX.Y.Z` mentions, which get bumped to the new version.
//   2. Download the upstream file at the new tag and split IT at its own
//      first `import`/`export`/`const` line the same way — everything
//      before that (the upstream license block, plus any incidental
//      pre-code comments) is discarded, since our header already covers
//      that ground.
//   3. Rewrite the upstream body's `@alias/*` and cross-directory relative
//      imports to point at sibling files in this vendor/ folder, per a
//      per-file mapping table sourced from that file's own provenance
//      comment (see VERBATIM_FILES below).
//   4. Reassemble header + rewritten body, then run it through this repo's
//      formatter (`vp fmt --write`) so the result matches house style
//      (double quotes, semicolons, trailing commas) instead of upstream's.
//
// Two files (protocol-types.ts, language.ts) are HAND-EXTRACTED subsets of a
// much larger upstream file (not verbatim copies) — this script deliberately
// does not touch them; it just flags them for manual re-verification.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;
const VENDOR_DIR = at("src/trace-viewer/vendor");
const VERSION_FILE = `${VENDOR_DIR}/version.ts`;
const VP_BIN = at("node_modules/.bin/vp");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const MAKE_PR = args.includes("--pr");

function fail(msg) {
  console.error(pc.red(`[sync-trace-vendor] ${msg}`));
  process.exit(1);
}
function warn(msg) {
  console.warn(pc.yellow(`[sync-trace-vendor] ${msg}`));
}
function info(msg) {
  console.log(pc.dim(`[sync-trace-vendor] ${msg}`));
}
function ok(msg) {
  console.log(pc.green(`[sync-trace-vendor] ${msg}`));
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// `playwright-core` is a transitive dep (via @playwright/test) and isn't
// directly resolvable under pnpm — hop through @playwright/test, which is
// (same dance as scripts/vendor-trace-viewer.mjs).
function resolvePlaywrightCoreVersion() {
  const req = createRequire(`${root}/`);
  try {
    const pkgPath = req.resolve("playwright-core/package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    // fall through to the @playwright/test hop below
  }
  try {
    const testPkg = req.resolve("@playwright/test/package.json");
    const req2 = createRequire(testPkg);
    const pkgPath = req2.resolve("playwright-core/package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    fail(
      "could not resolve `playwright-core` (via @playwright/test). Is it installed? Run `pnpm install`.",
    );
  }
  return "";
}

// ---------------------------------------------------------------------------
// Fully-verbatim vendored files: upstream path + import-rewrite table.
//
// The mapping for each file is transcribed from that file's own
// VENDOR-PROVENANCE comment in src/trace-viewer/vendor/*.ts — if you change
// a mapping here, update the matching comment too (and vice versa), they
// must describe the same adaptation.
// ---------------------------------------------------------------------------
const VERBATIM_FILES = [
  {
    local: "trace.ts",
    upstreamPath: "packages/trace/src/trace.ts",
    importMap: {
      "@isomorphic/locatorGenerators": "./language",
      "@protocol/channels": "./protocol-types",
    },
  },
  {
    local: "har.ts",
    upstreamPath: "packages/trace/src/har.ts",
    importMap: {},
  },
  {
    local: "entries.ts",
    upstreamPath: "packages/isomorphic/trace/entries.ts",
    importMap: {
      "../locatorGenerators": "./language",
      "@trace/snapshot": "./snapshot",
      "@trace/trace": "./trace",
    },
  },
  {
    local: "model-util.ts",
    upstreamPath: "packages/isomorphic/trace/traceModel.ts",
    importMap: {
      "../protocolFormatter": "./protocol-formatter",
      "../locatorGenerators": "./language",
      "@trace/snapshot": "./snapshot",
      "@trace/trace": "./trace",
      "@protocol/channels": "./protocol-types",
    },
    // Upstream's class is `TraceModel`; this repo also exports the
    // pre-refactor name `MultiTraceModel` as a zero-logic alias so existing
    // callers keep working. Not present upstream — re-inserted every sync
    // right after the class closes (see insertAfterClassClose below).
    aliasClassName: "TraceModel",
    bodyPatches: [
      {
        description:
          "drop the unused `i` index param upstream never reads (oxlint no-unused-vars)",
        find: ".map((error, i) => ({",
        replace: ".map((error) => ({",
      },
    ],
  },
  {
    local: "snapshot.ts",
    upstreamPath: "packages/trace/src/snapshot.ts",
    importMap: {},
  },
  {
    local: "protocol-formatter.ts",
    upstreamPath: "packages/isomorphic/protocolFormatter.ts",
    importMap: {
      "./protocolMetainfo": "./protocol-metainfo",
    },
    bodyPatches: [
      {
        description:
          "drop the unused `error` catch binding (oxlint flags unused catch bindings; ES2019 allows omitting it)",
        find: "} catch (error) {",
        replace: "} catch {",
      },
      {
        description:
          "drop upstream's ESLint-specific disable comment — meaningless under this repo's oxlint tooling",
        find: /\n *\/\/ eslint-disable-next-line no-restricted-globals\n/,
        replace: "\n",
      },
      {
        description:
          "add an oxlint-disable for a legitimate stringify-of-possibly-object call this repo's stricter typescript-eslint/no-base-to-string rule would otherwise flag",
        find: "  return String(current);",
        replace:
          "  // oxlint-disable-next-line typescript-eslint/no-base-to-string -- vendored verbatim from upstream: `current` may legitimately be a nested object at this point (deep param drill-down), and upstream intentionally stringifies whatever it finds for display purposes.\n  return String(current);",
      },
    ],
  },
  {
    local: "protocol-metainfo.ts",
    upstreamPath: "packages/isomorphic/protocolMetainfo.ts",
    importMap: {},
  },
];

// Hand-extracted subsets — NOT synced by this script. Each is a tiny slice
// hand-carved out of a much larger generated/hand-written upstream file;
// there's no mechanical "re-download and rewrite imports" for a subset, so
// we just flag them for a human to re-diff against the new tag.
const MANUAL_FILES = [
  {
    local: "protocol-types.ts",
    upstreamPath: "packages/protocol/src/channels.d.ts",
    note: "hand-extracted StackFrame/Point/SerializedError out of the full generated wire-protocol file",
  },
  {
    local: "language.ts",
    upstreamPath: "packages/isomorphic/locatorGenerators.ts",
    note: "hand-extracted the `Language` type alias out of the locator-codegen file",
  },
];

function localPath(name) {
  return `${VENDOR_DIR}/${name}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A "code line" is the first import/export/const statement — everything
// before it is scaffolding (a license/comment header in upstream files;
// license + oxlint-disable + VENDOR-PROVENANCE in ours).
function splitAtFirstCodeLine(content) {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => /^(import|export|const)\b/.test(l));
  if (idx === -1) return { header: content, body: "" };
  return {
    header: lines.slice(0, idx).join("\n"),
    body: lines.slice(idx).join("\n"),
  };
}

function bumpVersionMentions(header, oldVersion, newVersion) {
  if (oldVersion === newVersion) return header;
  return header.replaceAll(
    new RegExp(`tag v${escapeRegExp(oldVersion)}`, "g"),
    `tag v${newVersion}`,
  );
}

const IMPORT_FROM_RE = /\bfrom\s*(['"])([^'"]+)\1/g;

// Rewrites `from '<specifier>'` occurrences per the file's import map; fails
// loudly if the download contains a NEW non-relative import we don't have a
// mapping for — that means upstream's file layout moved again and this
// script's tables need a human to update them (silent pass-through here
// would ship a broken import).
function rewriteImports(body, importMap, upstreamPath) {
  const unknown = new Set();
  const rewritten = body.replace(IMPORT_FROM_RE, (full, _quote, specifier) => {
    if (Object.hasOwn(importMap, specifier)) {
      return `from "${importMap[specifier]}"`;
    }
    if (!specifier.startsWith(".")) unknown.add(specifier);
    return full;
  });
  if (unknown.size) {
    fail(
      `${upstreamPath}: found unmapped, non-relative import specifier(s) ` +
        `${[...unknown].map((s) => `"${s}"`).join(", ")} — upstream's file ` +
        `layout likely changed. Add a mapping to VERBATIM_FILES.importMap in ` +
        `this script (cross-check + update the file's VENDOR-PROVENANCE ` +
        `comment too) before re-running.`,
    );
  }
  return rewritten;
}

function multiTraceModelAlias(version) {
  return (
    "/**\n" +
    " * VENDOR-NOTE (compat alias, not upstream): the task brief that motivated\n" +
    " * vendoring this file referred to the exported class as `MultiTraceModel`\n" +
    " * (its pre-refactor name in older Playwright versions). This is a\n" +
    " * zero-logic re-export so code written against that name still resolves;\n" +
    ` * prefer \`TraceModel\` (the v${version} upstream name) in new code.\n` +
    " */\n" +
    "export { TraceModel as MultiTraceModel };"
  );
}

// Small, hand-documented deviations from strict verbatim — mostly cases
// where upstream code trips this repo's stricter lint config (unused catch
// bindings, unused params, a stringify-of-object rule) and the original
// vendoring pass hand-fixed them rather than blanket oxlint-disabling the
// whole file. Re-applied on every sync so the fix doesn't get silently
// reverted next time upstream is re-pulled.
function applyBodyPatches(body, patches, upstreamPath) {
  let out = body;
  for (const patch of patches ?? []) {
    const present =
      typeof patch.find === "string"
        ? out.includes(patch.find)
        : patch.find.test(out);
    if (!present) {
      warn(
        `${upstreamPath}: lint-fixup patch "${patch.description}" did not ` +
          `match anything — upstream may have changed this code; re-check ` +
          `this file by hand.`,
      );
      continue;
    }
    out = out.replace(patch.find, patch.replace);
  }
  return out;
}

// Inserts `insertText` as a new top-level statement right after the given
// class's own closing brace (NOT at the end of the file — the class may be
// followed by more top-level helper functions). Relies on this codebase's
// (and upstream's) convention that top-level closing braces sit at column 0
// while every nested block is indented, so the first standalone "}" line
// after the class's opening line is its own close.
function insertAfterClassClose(body, className, insertText) {
  const lines = body.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(`class ${className}`));
  if (startIdx === -1) {
    fail(`could not find "class ${className}" to anchor the alias export.`);
  }
  const closeIdx = lines.findIndex((l, i) => i > startIdx && l === "}");
  if (closeIdx === -1) {
    fail(`could not find the closing brace of "class ${className}".`);
  }
  lines.splice(closeIdx + 1, 0, "", insertText);
  return lines.join("\n");
}

async function downloadUpstream(tag, upstreamPath) {
  const url = `https://raw.githubusercontent.com/microsoft/playwright/${tag}/${upstreamPath}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`failed to fetch ${url}: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    fail(
      `GET ${url} -> HTTP ${res.status}. Does ${upstreamPath} still exist at ` +
        `tag ${tag}? Playwright's layout may have moved — update the ` +
        `upstreamPath in VERBATIM_FILES.`,
    );
  }
  return res.text();
}

// Runs the repo's own formatter over a file on disk so downloaded upstream
// content (single quotes, comma-separated type members, no semicolons)
// converges on house style instead of us hand-rolling a TS pretty-printer.
function formatFile(path) {
  if (!existsSync(VP_BIN)) {
    fail(`vp binary not found at ${VP_BIN}. Run \`pnpm install\`.`);
  }
  execFileSync(VP_BIN, ["fmt", "--write", path], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function buildFile(file, version) {
  const existing = readFileSync(localPath(file.local), "utf8");
  const { header: oldHeader } = splitAtFirstCodeLine(existing);
  const oldVersion = readVersionFile();
  const header = bumpVersionMentions(oldHeader, oldVersion, version);

  const tag = `v${version}`;
  const raw = await downloadUpstream(tag, file.upstreamPath);
  const { body: rawBody } = splitAtFirstCodeLine(raw);
  let body = rewriteImports(rawBody, file.importMap, file.upstreamPath);
  body = applyBodyPatches(body, file.bodyPatches, file.upstreamPath);

  if (file.aliasClassName && !body.includes("MultiTraceModel")) {
    body = insertAfterClassClose(
      body,
      file.aliasClassName,
      multiTraceModelAlias(version),
    );
  }

  return `${header}\n${body}`;
}

function readVersionFile() {
  const src = readFileSync(VERSION_FILE, "utf8");
  const m = src.match(/VENDORED_PLAYWRIGHT_VERSION\s*=\s*"([^"]+)"/);
  if (!m) fail(`could not find VENDORED_PLAYWRIGHT_VERSION in ${VERSION_FILE}`);
  return m[1];
}

function writeVersionFile(newVersion) {
  const src = readFileSync(VERSION_FILE, "utf8");
  const oldVersion = readVersionFile();
  const updated = src.replace(
    /VENDORED_PLAYWRIGHT_VERSION\s*=\s*"[^"]+"/,
    `VENDORED_PLAYWRIGHT_VERSION = "${newVersion}"`,
  );
  if (oldVersion === newVersion) return false;
  writeFileSync(VERSION_FILE, updated);
  return true;
}

async function main() {
  const version = resolvePlaywrightCoreVersion();
  const oldVersion = readVersionFile();
  info(
    `installed playwright-core ${version} (vendor/ currently pinned to ${oldVersion})`,
  );

  const scratch = mkdtempSync(join(tmpdir(), "sync-trace-vendor-"));
  const results = [];
  try {
    for (const file of VERBATIM_FILES) {
      const existingRaw = readFileSync(localPath(file.local), "utf8");
      const built = await buildFile(file, version);

      // Format on a scratch copy first — never touch the real vendor/ file
      // (or even a staged version of it) until we know what --dry-run mode
      // is; formatting requires a file on disk, so we always stage here.
      const scratchPath = join(scratch, file.local);
      writeFileSync(scratchPath, built);
      formatFile(scratchPath);
      const formatted = readFileSync(scratchPath, "utf8");

      const changed = formatted !== existingRaw;
      results.push({ file: file.local, changed, formatted });

      if (!DRY_RUN) {
        writeFileSync(localPath(file.local), formatted);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  let versionBumped = false;
  if (!DRY_RUN) {
    versionBumped = writeVersionFile(version);
  } else {
    versionBumped = oldVersion !== version;
  }

  // ---- Summary ----
  console.log("");
  console.log(pc.bold("[sync-trace-vendor] summary"));
  for (const r of results) {
    const status = r.changed ? pc.yellow("CHANGED") : pc.dim("unchanged");
    console.log(`  ${status}  vendor/${r.file}`);
  }
  console.log(
    `  ${versionBumped ? pc.yellow("CHANGED") : pc.dim("unchanged")}  vendor/version.ts (${oldVersion} -> ${version})`,
  );

  console.log("");
  console.log(pc.bold("[sync-trace-vendor] needs manual review (not synced)"));
  for (const m of MANUAL_FILES) {
    warn(`vendor/${m.local} <- ${m.upstreamPath}: ${m.note}`);
  }

  const anyChanged = results.some((r) => r.changed) || versionBumped;

  console.log("");
  console.log(pc.bold("[sync-trace-vendor] follow-up checklist"));
  console.log("  1. pnpm --filter @wrightful/dashboard test");
  console.log("  2. pnpm --filter @wrightful/e2e test:dashboard (replay e2e)");
  console.log(
    "  3. Manually re-verify vendor/protocol-types.ts + vendor/language.ts above",
  );
  console.log("  4. git diff --stat src/trace-viewer/vendor/");

  if (DRY_RUN) {
    ok(
      anyChanged
        ? "dry run complete — changes are available, nothing was written."
        : "dry run complete — installed playwright-core matches vendor/, nothing to sync.",
    );
    return;
  }

  if (!anyChanged) {
    ok("vendor/ already matches the installed playwright-core version.");
    return;
  }

  ok(`vendor/ synced to playwright-core ${version}.`);

  if (MAKE_PR) {
    await openPr(version);
  }
}

function git(gitArgs, opts = {}) {
  return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", ...opts });
}

async function openPr(version) {
  const status = git([
    "status",
    "--porcelain",
    "--",
    "src/trace-viewer/vendor",
  ]);
  if (!status.trim()) {
    info(
      "--pr requested but there are no vendor/ changes to commit — skipping.",
    );
    return;
  }

  const branch = `sync-trace-vendor-v${version}`;
  const title = `chore(trace-viewer): sync vendor/ to playwright-core v${version}`;
  const fileList = VERBATIM_FILES.map((f) => `- \`vendor/${f.local}\``).join(
    "\n",
  );
  const body = `## Summary
- Re-synced \`apps/dashboard/src/trace-viewer/vendor/\` from microsoft/playwright tag \`v${version}\` (matching the installed \`playwright-core\`).
- Files re-pulled + import-rewritten:
${fileList}
- \`vendor/version.ts\` bumped to \`${version}\`.
- \`vendor/protocol-types.ts\` and \`vendor/language.ts\` are hand-extracted subsets and were NOT touched — please re-verify them manually against the new tag.

## Test plan
- [ ] \`pnpm --filter @wrightful/dashboard test\`
- [ ] \`pnpm --filter @wrightful/e2e test:dashboard\` (replay e2e)
- [ ] Eyeball \`git diff\` for the vendor/ files above
- [ ] Manually re-check \`vendor/protocol-types.ts\` / \`vendor/language.ts\` against upstream v${version}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;

  try {
    git(["checkout", "-b", branch]);
    git(["add", "src/trace-viewer/vendor"]);
    git([
      "commit",
      "-m",
      `${title}\n\nRe-synced the vendored trace-model source from microsoft/playwright's\nv${version} tag to match the installed playwright-core.\n`,
    ]);
    git(["push", "-u", "origin", branch]);
    execFileSync(
      "gh",
      ["pr", "create", "--base", "main", "--title", title, "--body", body],
      { cwd: root, stdio: "inherit" },
    );
    ok(`opened PR for branch ${branch}.`);
  } catch (err) {
    warn(
      `--pr automation failed (${errorMessage(err)}). ` +
        `Run these manually instead:`,
    );
    console.log(pc.dim(`  git checkout -b ${branch}`));
    console.log(pc.dim(`  git add apps/dashboard/src/trace-viewer/vendor`));
    console.log(pc.dim(`  git commit -m "${title}"`));
    console.log(pc.dim(`  git push -u origin ${branch}`));
    console.log(
      pc.dim(
        `  gh pr create --base main --title "${title}" --body-file <(cat <<'EOF'\n${body}\nEOF\n)`,
      ),
    );
  }
}

await main();
