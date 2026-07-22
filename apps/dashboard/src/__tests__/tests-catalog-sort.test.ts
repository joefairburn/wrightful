import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TESTS_SORT,
  parseTestsSort,
  testsCatalogOrderBy,
} from "@/lib/tests-catalog-sort";

function rawText(expr: unknown): string {
  const chunk = expr as { strings: unknown };
  return Array.isArray(chunk.strings)
    ? chunk.strings.join("")
    : String(chunk.strings);
}

describe("parseTestsSort", () => {
  it("defaults to newest seen first", () => {
    expect(parseTestsSort(null, null)).toEqual(DEFAULT_TESTS_SORT);
  });

  it("uses the natural first direction for each column", () => {
    expect(parseTestsSort("test", null)).toEqual({
      key: "test",
      direction: "asc",
    });
    expect(parseTestsSort("runs", null)).toEqual({
      key: "runs",
      direction: "desc",
    });
    expect(parseTestsSort("duration", null)).toEqual({
      key: "duration",
      direction: "desc",
    });
  });

  it("honors an explicit direction, including for the default column", () => {
    expect(parseTestsSort(null, "asc")).toEqual({
      key: "last-seen",
      direction: "asc",
    });
    expect(parseTestsSort("test", "desc")).toEqual({
      key: "test",
      direction: "desc",
    });
  });

  it("rejects an unknown key as one state instead of pairing it with a direction", () => {
    expect(parseTestsSort("drop table", "asc")).toEqual(DEFAULT_TESTS_SORT);
  });
});

describe("testsCatalogOrderBy", () => {
  it("emits stable ordering for every sortable column", () => {
    expect(
      rawText(testsCatalogOrderBy({ key: "test", direction: "asc" })),
    ).toBe('lower("title") asc, "title" asc, "testId" asc');
    expect(
      rawText(testsCatalogOrderBy({ key: "runs", direction: "desc" })),
    ).toBe('"n" desc, "testId" asc');
    expect(
      rawText(testsCatalogOrderBy({ key: "duration", direction: "asc" })),
    ).toBe('"avgDurationMs" asc nulls last, "testId" asc');
    expect(
      rawText(testsCatalogOrderBy({ key: "last-seen", direction: "desc" })),
    ).toBe('"lastSeen" desc, "testId" asc');
  });
});
