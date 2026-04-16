import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
  deps: {
    alwaysBundle: [/.*/],
  },
  shims: true,
  outputOptions: {
    entryFileNames: "[name].js",
  },
});
