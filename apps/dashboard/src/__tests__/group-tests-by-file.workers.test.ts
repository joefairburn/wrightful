import { describe, expect, it } from "vite-plus/test";
import {
  filterTests,
  groupKeyId,
  groupLabel,
  parseTitleSegments,
  rawGroupKey,
} from "@/lib/group-tests-by-file";
import type {
  RunProgressTest,
  RunProgressTestStatus,
} from "@/realtime/run-progress";

let idSeq = 0;
function t(
  file: string,
  status: RunProgressTestStatus,
  overrides: Partial<RunProgressTest> = {},
): RunProgressTest {
  idSeq += 1;
  return {
    id: `id_${idSeq}`,
    testId: `test_${idSeq}`,
    title: `test ${idSeq}`,
    projectName: null,
    file,
    status,
    durationMs: 0,
    retryCount: 0,
    shardIndex: null,
    ...overrides,
  };
}

describe("parseTitleSegments", () => {
  it("handles a bare test title (no file or describes)", () => {
    expect(parseTitleSegments("smoke test", "a.spec.ts", null)).toEqual({
      describeChain: [],
      testTitle: "smoke test",
    });
  });

  it("strips the file basename when it leads the title", () => {
    expect(
      parseTitleSegments("a.spec.ts > smoke test", "a.spec.ts", null),
    ).toEqual({ describeChain: [], testTitle: "smoke test" });
  });

  it("strips the file basename when file is a path and title uses only the basename", () => {
    expect(
      parseTitleSegments(
        "checkout.spec.ts > Checkout > pays",
        "e2e/checkout.spec.ts",
        null,
      ),
    ).toEqual({ describeChain: ["Checkout"], testTitle: "pays" });
  });

  it("strips a leading projectName before the file segment", () => {
    expect(
      parseTitleSegments(
        "chromium > flaky.spec.ts > Promo codes > validates",
        "flaky.spec.ts",
        "chromium",
      ),
    ).toEqual({ describeChain: ["Promo codes"], testTitle: "validates" });
  });

  it("returns the whole chain as describes when there's no test title following", () => {
    expect(parseTitleSegments("only", "a.spec.ts", null)).toEqual({
      describeChain: [],
      testTitle: "only",
    });
  });

  it("keeps nested describe blocks", () => {
    expect(
      parseTitleSegments(
        "flaky.spec.ts > Promo codes > Expired > blocks expired @fails",
        "flaky.spec.ts",
        null,
      ),
    ).toEqual({
      describeChain: ["Promo codes", "Expired"],
      testTitle: "blocks expired @fails",
    });
  });

  it("does not strip segments that coincidentally contain the basename", () => {
    expect(
      parseTitleSegments("not-a.spec.ts > title", "a.spec.ts", null),
    ).toEqual({
      describeChain: ["not-a.spec.ts"],
      testTitle: "title",
    });
  });
});

describe("filterTests", () => {
  const rows = [
    t("e2e/login.spec.ts", "failed", { title: "logs in with password" }),
    t("e2e/login.spec.ts", "passed", { title: "logs out" }),
    t("e2e/checkout.spec.ts", "flaky", { title: "applies a promo code" }),
    t("e2e/checkout.spec.ts", "timedout", { title: "charges the card" }),
    t("e2e/cart.spec.ts", "skipped", { title: "shows empty state" }),
  ];

  it("returns everything when status is `all` and search is empty", () => {
    expect(filterTests(rows, { search: "", statusFilter: "all" })).toHaveLength(
      5,
    );
  });

  it("filters by collapsed bucket — `failed` includes timedout, excludes flaky", () => {
    const failed = filterTests(rows, { search: "", statusFilter: "failed" });
    expect(failed.map((r) => r.title)).toEqual([
      "logs in with password",
      "charges the card",
    ]);
  });

  it("filters by `flaky` bucket", () => {
    const flaky = filterTests(rows, { search: "", statusFilter: "flaky" });
    expect(flaky.map((r) => r.title)).toEqual(["applies a promo code"]);
  });

  it("matches the needle against title (case-insensitive)", () => {
    const hits = filterTests(rows, { search: "PROMO", statusFilter: "all" });
    expect(hits.map((r) => r.title)).toEqual(["applies a promo code"]);
  });

  it("matches the needle against the file path", () => {
    const hits = filterTests(rows, { search: "checkout", statusFilter: "all" });
    expect(hits).toHaveLength(2);
    expect(hits.every((r) => r.file === "e2e/checkout.spec.ts")).toBe(true);
  });

  it("combines status filter AND search (intersection)", () => {
    const hits = filterTests(rows, {
      search: "login",
      statusFilter: "failed",
    });
    expect(hits.map((r) => r.title)).toEqual(["logs in with password"]);
  });

  it("ignores whitespace-only search", () => {
    expect(
      filterTests(rows, { search: "   ", statusFilter: "all" }),
    ).toHaveLength(5);
  });

  it("preserves input order", () => {
    const hits = filterTests(rows, { search: "", statusFilter: "all" });
    expect(hits.map((r) => r.title)).toEqual(rows.map((r) => r.title));
  });
});

// The group-key contract shared by the SERVER skeleton (`loadRunGroupSkeleton`'s
// `key`) and the CLIENT (identity + label + live-overlay routing). A divergence
// here silently mismatches a streamed row to the wrong header, so these pin it.
describe("rawGroupKey", () => {
  it("returns the raw file (empty string kept, never null since file is NOT NULL)", () => {
    expect(rawGroupKey(t("a/b.spec.ts", "passed"), "file")).toBe("a/b.spec.ts");
    expect(rawGroupKey(t("", "passed"), "file")).toBe("");
  });

  it("returns projectName or null for the project axis", () => {
    expect(
      rawGroupKey(t("f", "passed", { projectName: "chromium" }), "project"),
    ).toBe("chromium");
    expect(
      rawGroupKey(t("f", "passed", { projectName: null }), "project"),
    ).toBeNull();
  });

  it("stringifies shardIndex and maps a non-sharded row to null", () => {
    expect(rawGroupKey(t("f", "passed", { shardIndex: 3 }), "shard")).toBe("3");
    expect(
      rawGroupKey(t("f", "passed", { shardIndex: null }), "shard"),
    ).toBeNull();
  });
});

describe("groupKeyId", () => {
  it("passes a real key through and gives null a stable sentinel", () => {
    expect(groupKeyId("a.spec.ts")).toBe("a.spec.ts");
    // The sentinel can't collide with a real key (real keys are non-null here).
    expect(groupKeyId(null)).not.toBe("");
    expect(groupKeyId(null)).toBe(groupKeyId(null));
  });
});

describe("groupLabel", () => {
  it("renders each axis's fallback label for a null/empty key", () => {
    expect(groupLabel("file", "a.spec.ts")).toBe("a.spec.ts");
    expect(groupLabel("file", "")).toBe("Other");
    expect(groupLabel("project", "chromium")).toBe("chromium");
    expect(groupLabel("project", null)).toBe("default");
    expect(groupLabel("shard", "2")).toBe("Shard 2");
    expect(groupLabel("shard", null)).toBe("Unsharded");
  });
});
