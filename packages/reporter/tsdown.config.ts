import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg: { version: string } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  sourcemap: true,
  // Substitute the literal package.json version into the bundle so the
  // runtime `reporterVersion` field can't drift from the published package.
  // The `typeof __REPORTER_VERSION__` guard in index.ts falls back to a dev
  // string when running source-mode (Vitest, ts-node) where this define is
  // not applied.
  define: {
    __REPORTER_VERSION__: JSON.stringify(pkg.version),
  },
  // package.json is `"type": "module"`, so .js is already ESM. Using .js
  // (not .mjs) matches the CLI output convention and keeps the
  // package.json exports entry (`./dist/index.js`) resolvable.
  outputOptions: {
    entryFileNames: "[name].js",
  },
});
