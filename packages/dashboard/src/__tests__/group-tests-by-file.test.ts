import { describe, expect, it } from "vitest";
import {
  buildDescribeTree,
  groupTestsByFile,
  parseTitleSegments,
  type DescribeBranch,
  type DescribeTestLeaf,
} from "../lib/group-tests-by-file";
import type {
  RunProgressTest,
  RunProgressTestStatus,
} from "../routes/api/progress";

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
    errorMessage: null,
    errorStack: null,
    ...overrides,
  };
}

describe("groupTestsByFile", () => {
  it("returns an empty array for an empty input", () => {
    expect(groupTestsByFile([])).toEqual([]);
  });

  it("groups a single file with a single test", () => {
    const groups = groupTestsByFile([t("e2e/login.spec.ts", "passed")]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.file).toBe("e2e/login.spec.ts");
    expect(group.dir).toBe("e2e/");
    expect(group.basename).toBe("login.spec.ts");
    expect(group.tests).toHaveLength(1);
    expect(group.counts.passed).toBe(1);
    expect(group.worstStatus).toBe("passed");
  });

  it("splits basename from directory; bare filenames have no dir", () => {
    const [group] = groupTestsByFile([t("root.spec.ts", "passed")]);
    expect(group.dir).toBe("");
    expect(group.basename).toBe("root.spec.ts");
  });

  it("buckets tests with a missing file into a trailing 'Other' group", () => {
    const groups = groupTestsByFile([
      t("e2e/a.spec.ts", "passed"),
      t("", "failed"),
      t("   ", "passed"),
    ]);
    const names = groups.map((g) => g.basename);
    expect(names).toEqual(["a.spec.ts", "Other"]);
    const other = groups.find((g) => g.basename === "Other");
    expect(other?.tests).toHaveLength(2);
    expect(other?.file).toBe("");
  });

  it("sums durationMs across the tests in a group", () => {
    const [group] = groupTestsByFile([
      t("a.spec.ts", "passed", { durationMs: 100 }),
      t("a.spec.ts", "passed", { durationMs: 250 }),
      t("a.spec.ts", "failed", { durationMs: 50 }),
    ]);
    expect(group.durationMs).toBe(400);
  });

  it("tracks per-status counts", () => {
    const [group] = groupTestsByFile([
      t("a.spec.ts", "passed"),
      t("a.spec.ts", "passed"),
      t("a.spec.ts", "failed"),
      t("a.spec.ts", "flaky"),
      t("a.spec.ts", "skipped"),
      t("a.spec.ts", "timedout"),
      t("a.spec.ts", "queued"),
    ]);
    expect(group.counts).toEqual({
      passed: 2,
      failed: 1,
      flaky: 1,
      skipped: 1,
      timedout: 1,
      queued: 1,
    });
  });

  it("computes worstStatus by severity (failed > timedout > flaky > queued > skipped > passed)", () => {
    expect(
      groupTestsByFile([t("a.spec.ts", "passed"), t("a.spec.ts", "skipped")])[0]
        .worstStatus,
    ).toBe("skipped");
    expect(
      groupTestsByFile([t("a.spec.ts", "passed"), t("a.spec.ts", "queued")])[0]
        .worstStatus,
    ).toBe("queued");
    expect(
      groupTestsByFile([
        t("a.spec.ts", "queued"),
        t("a.spec.ts", "flaky"),
        t("a.spec.ts", "passed"),
      ])[0].worstStatus,
    ).toBe("flaky");
    expect(
      groupTestsByFile([t("a.spec.ts", "flaky"), t("a.spec.ts", "timedout")])[0]
        .worstStatus,
    ).toBe("timedout");
    expect(
      groupTestsByFile([
        t("a.spec.ts", "timedout"),
        t("a.spec.ts", "failed"),
      ])[0].worstStatus,
    ).toBe("failed");
  });

  it("sorts groups by worst-status severity, then by file path", () => {
    const groups = groupTestsByFile([
      t("b.spec.ts", "passed"),
      t("a.spec.ts", "passed"),
      t("c.spec.ts", "failed"),
      t("d.spec.ts", "flaky"),
    ]);
    expect(groups.map((g) => g.file)).toEqual([
      "c.spec.ts",
      "d.spec.ts",
      "a.spec.ts",
      "b.spec.ts",
    ]);
  });

  it("always places the 'Other' group last, even if it has failing tests", () => {
    const groups = groupTestsByFile([
      t("a.spec.ts", "passed"),
      t("", "failed"),
    ]);
    expect(groups.map((g) => g.basename)).toEqual(["a.spec.ts", "Other"]);
  });

  it("collects unique projectNames, sorted", () => {
    const [group] = groupTestsByFile([
      t("a.spec.ts", "passed", { projectName: "firefox" }),
      t("a.spec.ts", "passed", { projectName: "chromium" }),
      t("a.spec.ts", "passed", { projectName: "firefox" }),
      t("a.spec.ts", "passed", { projectName: null }),
    ]);
    expect(group.projectNames).toEqual(["chromium", "firefox"]);
  });

  it("preserves input order of tests within a group", () => {
    const a = t("a.spec.ts", "failed");
    const b = t("a.spec.ts", "passed");
    const c = t("a.spec.ts", "skipped");
    const [group] = groupTestsByFile([a, b, c]);
    expect(group.tests.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });
});

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
    // Degenerate: identical to test title alone. Defensive.
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
    // Only an exact match on the leading segment is stripped.
    expect(
      parseTitleSegments("not-a.spec.ts > title", "a.spec.ts", null),
    ).toEqual({
      describeChain: ["not-a.spec.ts"],
      testTitle: "title",
    });
  });
});

describe("buildDescribeTree", () => {
  it("returns an empty tree for an empty input", () => {
    expect(buildDescribeTree([], "a.spec.ts")).toEqual([]);
  });

  it("renders a single test with no describe as a root leaf", () => {
    const test = t("a.spec.ts", "passed", {
      title: "a.spec.ts > smoke",
    });
    const tree = buildDescribeTree([test], "a.spec.ts");
    expect(tree).toHaveLength(1);
    const [leaf] = tree as [DescribeTestLeaf];
    expect(leaf.kind).toBe("test");
    expect(leaf.displayTitle).toBe("smoke");
    expect(leaf.test).toBe(test);
  });

  it("nests tests under a shared describe block", () => {
    const a = t("a.spec.ts", "passed", {
      title: "a.spec.ts > Checkout > pays with card",
    });
    const b = t("a.spec.ts", "failed", {
      title: "a.spec.ts > Checkout > rejects invalid code",
    });
    const tree = buildDescribeTree([a, b], "a.spec.ts");
    expect(tree).toHaveLength(1);
    const [branch] = tree as [DescribeBranch];
    expect(branch.kind).toBe("describe");
    expect(branch.name).toBe("Checkout");
    expect(branch.children).toHaveLength(2);
    expect(
      branch.children.map((c) => (c as DescribeTestLeaf).displayTitle),
    ).toEqual(["pays with card", "rejects invalid code"]);
  });

  it("handles mixed root-level tests and describe branches", () => {
    const top = t("a.spec.ts", "passed", {
      title: "a.spec.ts > top-level smoke",
    });
    const nested = t("a.spec.ts", "passed", {
      title: "a.spec.ts > Checkout > pays",
    });
    const tree = buildDescribeTree([top, nested], "a.spec.ts");
    expect(tree).toHaveLength(2);
    expect(tree[0].kind).toBe("test");
    expect(tree[1].kind).toBe("describe");
  });

  it("supports deeply nested describes with siblings at each level", () => {
    const a = t("a.spec.ts", "failed", {
      title: "a.spec.ts > Promo codes > Expired > blocks expired",
    });
    const b = t("a.spec.ts", "flaky", {
      title: "a.spec.ts > Promo codes > Expired > warns on expiry",
    });
    const c = t("a.spec.ts", "passed", {
      title: "a.spec.ts > Promo codes > Valid > applies discount",
    });
    const tree = buildDescribeTree([a, b, c], "a.spec.ts");
    expect(tree).toHaveLength(1);
    const [promoCodes] = tree as [DescribeBranch];
    expect(promoCodes.name).toBe("Promo codes");
    expect(promoCodes.children).toHaveLength(2);
    const [expired, valid] = promoCodes.children as [
      DescribeBranch,
      DescribeBranch,
    ];
    expect(expired.name).toBe("Expired");
    expect(expired.children).toHaveLength(2);
    expect(valid.name).toBe("Valid");
    expect(valid.children).toHaveLength(1);
  });

  it("preserves first-seen order for sibling branches", () => {
    const a = t("a.spec.ts", "passed", {
      title: "a.spec.ts > B > one",
    });
    const b = t("a.spec.ts", "passed", {
      title: "a.spec.ts > A > one",
    });
    const tree = buildDescribeTree([a, b], "a.spec.ts");
    expect(tree.map((n) => (n as DescribeBranch).name)).toEqual(["B", "A"]);
  });
});
