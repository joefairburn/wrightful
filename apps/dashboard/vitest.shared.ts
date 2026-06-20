import { fileURLToPath } from "node:url";

// Shared test-config primitives, imported by BOTH the Node lane (vite.config.ts)
// and the workerd lane (vitest.workers.config.ts). This module MUST stay a plain
// config helper — relative imports only, no top-level side effects, no circular
// deps — because vite.config.ts is the live build/dev config and imports it.
//
// The two lanes MUST resolve `void/db` (and `@`/`@schema`) to the SAME files, or
// they'd silently test different module graphs. Keeping the constants + alias map
// here, in one place, is what guarantees that.
//
// These URLs resolve relative to THIS module's location (apps/dashboard/), which
// is the same directory as both configs — so the paths are unchanged from the
// previous inline definitions.
export const srcDir = fileURLToPath(new URL("./src", import.meta.url));
export const schemaPath = fileURLToPath(
  new URL("./db/schema.ts", import.meta.url),
);
export const voidDbStubPath = fileURLToPath(
  new URL("./src/__tests__/helpers/void-db-stub.ts", import.meta.url),
);

// The test-mode alias map shared by both lanes. Tests run without the void
// plugin, so the virtual `@schema` and `void/db` modules aren't materialized —
// alias them to real files (the schema source, and a stub that re-exports
// drizzle operators and a guarded `db` placeholder). `cloudflare:workers` is
// handled per-lane (the Node lane aliases it to a stub; the workerd lane uses
// pool-workers' real module), so it is deliberately NOT included here.
export const testAlias = {
  "@": srcDir,
  "@schema": schemaPath,
  "void/db": voidDbStubPath,
} as const;

// Shared miniflare runtime config for the workerd lanes (vitest.workers.config.ts
// and vitest.workers.db.config.ts), so the two stay on the same runtime version.
export const MINIFLARE_BASE = {
  compatibilityDate: "2026-05-22",
  compatibilityFlags: ["nodejs_compat"],
} as const;
