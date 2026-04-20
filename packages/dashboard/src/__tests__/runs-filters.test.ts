import { describe, expect, it } from "vitest";
import {
  buildRunsWhere,
  EMPTY_FILTERS,
  hasAnyFilter,
  parseRunsFilters,
} from "../lib/runs-filters";

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
});

describe("buildRunsWhere", () => {
  it("returns a SQL clause for empty filters and every filter field set", () => {
    expect(buildRunsWhere("proj_123", EMPTY_FILTERS)).toBeDefined();
    expect(
      buildRunsWhere("proj_123", {
        q: "login",
        status: ["failed"],
        branch: ["main"],
        actor: ["alice"],
        environment: ["production"],
        from: "2026-04-01",
        to: "2026-04-15",
      }),
    ).toBeDefined();
  });
});
