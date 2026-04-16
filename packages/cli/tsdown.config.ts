import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  sourcemap: true,
  clean: true,
  outputOptions: {
    banner: "#!/usr/bin/env node",
    entryFileNames: "[name].js",
  },
});
