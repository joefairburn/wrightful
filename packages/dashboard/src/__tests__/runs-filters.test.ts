import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import type { TenantDatabase } from "@/tenant";
import {
  buildRunsWhere,
  EMPTY_FILTERS,
  hasAnyFilter,
  parseRunsFilters,
  type RunStatus,
  toSearchParams,
} from "../lib/runs-filters";

function makeDb(): Kysely<TenantDatabase> {
  // No CamelCasePlugin — the tenant DO stores columns with camelCase names
  // verbatim (see src/tenant/migrations.ts).
  return new Kysely<TenantDatabase>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

function parse(qs: string) {
  return parseRunsFilters(new URLSearchParams(qs));
}

describe("parseRunsFilters", () => {
  it("returns empty defaults for an empty querystring", () => {
    expect(parse("")).toEqual(EMPTY_FILTERS);
  });

  it("keeps a valid calendar date", () => {
    expect(parse("from=2026-04-01").from).toBe("2026-04-01");
    expect(parse("to=2026-04-15").to).toBe("2026-04-15");
  });

  it("drops a shape-invalid date", () => {
    expect(parse("from=2026-4-1").from).toBeNull();
    expect(parse("to=not-a-date").to).toBeNull();
    expect(parse("from=").from).toBeNull();
  });

  it("drops a calendar-invalid date (regression for silent Feb-30 roll)", () => {
    expect(parse("from=2026-02-30").from).toBeNull();
    expect(parse("to=2026-13-01").to).toBeNull();
    expect(parse("from=2025-02-29").from).toBeNull();
  });

  it("filters status to the known whitelist", () => {
    expect(parse("status=failed,flaky,bogus").status).toEqual([
      "failed",
      "flaky",
    ]);
    expect(parse("status=banana").status).toEqual([]);
  });

  it("splits comma lists and trims whitespace", () => {
    expect(parse("branch=main%2C%20release%2F1.0").branch).toEqual([
      "main",
      "release/1.0",
    ]);
  });

  it("trims q", () => {
    expect(parse("q=%20%20login%20%20").q).toBe("login");
  });

  it("caps list filters at 50 values to stay under D1's 100-param limit", () => {
    const branches = Array.from({ length: 120 }, (_, i) => `b${i}`).join(",");
    const f = parse(`branch=${branches}`);
    expect(f.branch).toHaveLength(50);
    expect(f.branch[0]).toBe("b0");
    expect(f.branch[49]).toBe("b49");
  });

  it("defaults page to 1 when absent, non-numeric, or out of range", () => {
    expect(parse("").page).toBe(1);
    expect(parse("page=abc").page).toBe(1);
    expect(parse("page=0").page).toBe(1);
    expect(parse("page=-5").page).toBe(1);
  });

  it("parses a valid page number", () => {
    expect(parse("page=2").page).toBe(2);
    expect(parse("page=42").page).toBe(42);
  });
});

describe("toSearchParams", () => {
  it("omits page when it is 1", () => {
    const params = toSearchParams(EMPTY_FILTERS);
    expect(params.has("page")).toBe(false);
  });

  it("includes page when greater than 1", () => {
    const params = toSearchParams({ ...EMPTY_FILTERS, page: 3 });
    expect(params.get("page")).toBe("3");
  });

  it("round-trips through parseRunsFilters", () => {
    const original = {
      ...EMPTY_FILTERS,
      status: ["failed"] as RunStatus[],
      page: 4,
    };
    const roundTripped = parseRunsFilters(toSearchParams(original));
    expect(roundTripped.page).toBe(4);
    expect(roundTripped.status).toEqual(["failed"]);
  });
});

describe("hasAnyFilter", () => {
  it("is false for empty filters", () => {
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false);
  });

  it("is true when any field is set", () => {
    expect(hasAnyFilter({ ...EMPTY_FILTERS, q: "x" })).toBe(true);
    expect(hasAnyFilter({ ...EMPTY_FILTERS, status: ["failed"] })).toBe(true);
    expect(hasAnyFilter({ ...EMPTY_FILTERS, from: "2026-04-01" })).toBe(true);
  });

  it("is false when only page is set — pagination isn't a filter", () => {
    expect(hasAnyFilter({ ...EMPTY_FILTERS, page: 5 })).toBe(false);
  });
});

describe("buildRunsWhere", () => {
  it("compiles a projectId-scoped predicate for every filter combination", () => {
    const db = makeDb();
    // Empty filters — projectId + committed clauses only.
    const empty = db
      .selectFrom("runs")
      .selectAll()
      .where((eb) => buildRunsWhere(eb, "proj_123", EMPTY_FILTERS))
      .compile();
    expect(empty.sql).toMatch(/"projectId"\s*=\s*\?/);
    expect(empty.sql).toMatch(/"committed"\s*=\s*\?/);
    expect(empty.parameters).toContain("proj_123");

    // All filters — ensures every branch of the builder contributes a clause.
    const full = db
      .selectFrom("runs")
      .selectAll()
      .where((eb) =>
        buildRunsWhere(eb, "proj_123", {
          q: "login",
          status: ["failed"],
          branch: ["main"],
          actor: ["alice"],
          environment: ["production"],
          from: "2026-04-01",
          to: "2026-04-15",
          page: 1,
        }),
      )
      .compile();
    expect(full.sql).toMatch(/"projectId"\s*=\s*\?/);
    expect(full.sql).toMatch(/"committed"\s*=\s*\?/);
    expect(full.sql).toMatch(/"status"\s+in\s*\(\s*\?\s*\)/i);
    expect(full.sql).toMatch(/"branch"\s+in\s*\(\s*\?\s*\)/i);
    expect(full.sql).toMatch(/"actor"\s+in\s*\(\s*\?\s*\)/i);
    expect(full.sql).toMatch(/"environment"\s+in\s*\(\s*\?\s*\)/i);
    expect(full.sql).toMatch(/"createdAt"\s*>=\s*\?/);
    expect(full.sql).toMatch(/"createdAt"\s*<=\s*\?/);
  });
});
