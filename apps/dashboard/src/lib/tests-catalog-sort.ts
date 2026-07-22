import { sql } from "void/db";

export const TESTS_SORT_KEYS = [
  "test",
  "runs",
  "duration",
  "last-seen",
] as const;

export type TestsSortKey = (typeof TESTS_SORT_KEYS)[number];
export type TestsSortDirection = "asc" | "desc";

export interface TestsSortState {
  key: TestsSortKey;
  direction: TestsSortDirection;
}

export const DEFAULT_TESTS_SORT: TestsSortState = {
  key: "last-seen",
  direction: "desc",
};

export function defaultTestsSortDirection(
  key: TestsSortKey,
): TestsSortDirection {
  return key === "test" ? "asc" : "desc";
}

/** Normalize the URL's closed sort vocabulary before it reaches SQL or UI. */
export function parseTestsSort(
  keyParam: string | null,
  directionParam: string | null,
): TestsSortState {
  const validKey = TESTS_SORT_KEYS.find((key) => key === keyParam);
  if (keyParam !== null && !validKey) return DEFAULT_TESTS_SORT;

  const key = validKey ?? DEFAULT_TESTS_SORT.key;
  const direction =
    directionParam === "asc" || directionParam === "desc"
      ? directionParam
      : defaultTestsSortDirection(key);
  return { key, direction };
}

/**
 * ORDER BY for the grouped page query. All identifiers come from the closed
 * TestsSortKey union above; the URL value is never interpolated directly.
 */
export function testsCatalogOrderBy({
  key,
  direction,
}: TestsSortState): ReturnType<typeof sql> {
  const suffix = direction === "asc" ? "asc" : "desc";
  switch (key) {
    case "test":
      return sql.raw(
        `lower("title") ${suffix}, "title" ${suffix}, "testId" ${suffix}`,
      );
    case "runs":
      return sql.raw(`"n" ${suffix}, "testId" asc`);
    case "duration":
      return sql.raw(`"avgDurationMs" ${suffix} nulls last, "testId" asc`);
    case "last-seen":
      return sql.raw(`"lastSeen" ${suffix}, "testId" asc`);
  }
}
