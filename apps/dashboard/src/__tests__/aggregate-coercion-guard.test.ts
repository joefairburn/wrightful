import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * int8-as-string coercion guard for builder-path aggregates.
 *
 * The dashboard runs on Postgres. The production node-postgres driver returns
 * `int8` (the type of `count(*)` / `sum(int)`) and `numeric` (`avg`) as JS
 * **strings**, to avoid silent 64-bit precision loss. A bare
 * `sql<number>\`count(*)\`` only sets the TypeScript type — it attaches NO
 * runtime decoder — so the value is a string at runtime while the types claim
 * `number`, and `"5" + 1` arithmetic bugs follow.
 *
 * The pglite test lane returns numbers for these expressions, so unit tests do
 * NOT catch a missing coercion. This static guard does: it scans the
 * `db.select({...})` builder-path source for any `sql<number>` /
 * `sql<number | null>` whose template contains `count(`, `sum(`, or `avg(` and
 * fails if found — those must be wrapped in `numericSql(...)` from
 * `@/lib/db/sql-ops`, which attaches `.mapWith(Number)`.
 *
 * Notes / scope:
 *  - `numericSql(sql\`…\`)` uses a BARE `sql` tag (no `<number>` annotation), so
 *    a correctly-wrapped aggregate never matches the trap regex — any
 *    `sql<number>` carrying count/sum/avg is by definition unwrapped.
 *  - `sql<number | string>` is intentionally excluded: that union is used for
 *    bucket keys where the string form is deliberate, not a coercion bug.
 *  - Raw `runRows`/`runRow` queries bypass Drizzle's field decoders entirely,
 *    so they must `cast(… as integer)` / `cast(… as double precision)` IN the
 *    SQL string instead — those are not covered here (no `sql<number>` to flag).
 *  - `max()`/`min()` over an int4 column return int4 → a JS number, so they are
 *    safe and need no coercion.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "../..");
const pagesDir = join(appRoot, "pages");
const srcDir = join(appRoot, "src");

/** The builder-path trap: a `sql<number>` annotation whose template literal
 *  carries a count/sum/avg aggregate. Wrapped `numericSql(sql\`…\`)` calls use a
 *  bare `sql` tag and so never match. */
const TRAP =
  /\bsql<number(?:\s*\|\s*null)?>\s*`[^`]*\b(?:count|sum|avg)\s*\(/gi;

function collectTsFiles(root: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        // Skip test fixtures + the suite itself; the helper is the source of
        // the intended bare-`sql` mapper and must not be flagged.
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!full.endsWith(suffix)) continue;
      if (full.includes("__tests__")) continue;
      // The coercion helper itself defines numericSql over a bare `sql` tag;
      // exclude it explicitly (it never uses `sql<number>` anyway).
      if (full.endsWith(join("src", "lib", "db", "sql-ops.ts"))) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

const scanned = [
  ...collectTsFiles(pagesDir, ".server.ts"),
  ...collectTsFiles(srcDir, ".ts"),
];

describe("aggregate int8-as-string coercion guard (builder path)", () => {
  it("scans a non-trivial set of source files", () => {
    // Sanity: if the glob roots move, we want a loud failure here rather than
    // a silently-empty (and therefore always-green) scan.
    expect(scanned.length).toBeGreaterThan(0);
  });

  it("has no unwrapped `sql<number>` count/sum/avg aggregates", () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, "utf8");
      TRAP.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TRAP.exec(text)) !== null) {
        const rel = relative(appRoot, file);
        offenders.push(`${rel}: ${match[0].trim()}`);
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Found unwrapped int8/numeric aggregates — wrap each in ` +
            `numericSql(...) from "@/lib/db/sql-ops":\n  ${offenders.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});
