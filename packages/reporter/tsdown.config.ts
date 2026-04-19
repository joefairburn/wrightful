import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  // package.json is `"type": "module"`, so .js is already ESM. Using .js
  // (not .mjs) matches the CLI output convention and keeps the
  // package.json exports entry (`./dist/index.js`) resolvable.
  outputOptions: {
    entryFileNames: "[name].js",
  },
});
