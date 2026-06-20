import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { MINIFLARE_BASE, testAlias } from "./vitest.shared";

// The workerd test lane. Server-side suites — the code that actually runs in
// workerd in production (db layer, ingest, query building) — run here inside
// the real Workers runtime via miniflare, rather than the Node + happy-dom
// lane in vite.config.ts. A suite opts in via the `*.workers.test.ts` filename
// suffix; the Node lane excludes that same glob, so nothing double-runs.
// Components / client islands (which run in the browser, not workerd) and the
// pglite/disk-bound DB-integration tests deliberately stay on the Node lane.
//
// Uses an INLINE miniflare worker (no `wrangler.configPath`) so it is
// self-contained and CI-safe: it does not depend on the gitignored, generated
// wrangler.jsonc and does not bundle the app worker. The test-mode aliases
// (`testAlias`, shared with vite.config.ts via vitest.shared.ts) keep both lanes
// resolving `void/db` → the same stub and `@schema` → the real schema, with
// voidPlugin off here too. `cloudflare:workers` is deliberately NOT aliased —
// pool-workers provides the real module.

export default defineConfig({
  resolve: {
    alias: { ...testAlias },
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    cloudflareTest({
      miniflare: { ...MINIFLARE_BASE },
    }),
  ],
  test: {
    include: ["src/**/*.workers.test.{ts,tsx}"],
  },
});
