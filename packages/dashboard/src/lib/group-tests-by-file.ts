import type {
  RunProgressTest,
  RunProgressTestStatus,
} from "@/routes/api/progress";

export interface FileGroupCounts {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  timedout: number;
  queued: number;
}

export interface FileGroup {
  file: string;
  basename: string;
  dir: string;
  tests: RunProgressTest[];
  counts: FileGroupCounts;
  durationMs: number;
  projectNames: string[];
  worstStatus: RunProgressTestStatus;
}

const STATUS_SEVERITY: Record<RunProgressTestStatus, number> = {
  failed: 0,
  timedout: 1,
  flaky: 2,
  queued: 3,
  skipped: 4,
  passed: 5,
};

const UNGROUPED_KEY = "";

function splitPath(path: string): { dir: string; basename: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", basename: path };
  return { dir: path.slice(0, idx + 1), basename: path.slice(idx + 1) };
}

function worseOf(
  a: RunProgressTestStatus,
  b: RunProgressTestStatus,
): RunProgressTestStatus {
  return STATUS_SEVERITY[a] <= STATUS_SEVERITY[b] ? a : b;
}

/**
 * Group a flat list of test results by their `file` path. Pure — safe to call
 * from RSC render paths and inside `useMemo` in client islands.
 *
 * Group order is worst-status-first (failed → timedout → flaky → queued →
 * skipped → passed). Tests within a group keep the caller's input order, so
 * the caller can sort the flat list first if it wants per-group ordering.
 *
 * Tests whose `file` is empty or whitespace are collected into a trailing
 * "Other" group — defensive for rows that somehow slipped through without a
 * file path.
 */
export function groupTestsByFile(tests: RunProgressTest[]): FileGroup[] {
  const map = new Map<string, FileGroup>();

  for (const test of tests) {
    const key = test.file && test.file.trim() ? test.file : UNGROUPED_KEY;
    let group = map.get(key);
    if (!group) {
      const { dir, basename } =
        key === UNGROUPED_KEY ? { dir: "", basename: "Other" } : splitPath(key);
      group = {
        file: key,
        basename,
        dir,
        tests: [],
        counts: {
          passed: 0,
          failed: 0,
          flaky: 0,
          skipped: 0,
          timedout: 0,
          queued: 0,
        },
        durationMs: 0,
        projectNames: [],
        worstStatus: "passed",
      };
      map.set(key, group);
    }
    group.tests.push(test);
    group.counts[test.status] += 1;
    group.durationMs += test.durationMs;
    group.worstStatus = worseOf(group.worstStatus, test.status);
    if (test.projectName && !group.projectNames.includes(test.projectName)) {
      group.projectNames.push(test.projectName);
    }
  }

  for (const group of map.values()) {
    group.projectNames.sort();
  }

  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (a.file === UNGROUPED_KEY) return 1;
    if (b.file === UNGROUPED_KEY) return -1;
    const sev = STATUS_SEVERITY[a.worstStatus] - STATUS_SEVERITY[b.worstStatus];
    if (sev !== 0) return sev;
    return a.file.localeCompare(b.file);
  });
  return groups;
}

/**
 * Strip the `projectName` and `file` prefixes that Playwright's
 * `test.titlePath()` bakes into the stored `title`. What's left is the
 * describe-block chain ending with the leaf test title.
 *
 * Playwright builds title with shape:
 *   [rootSuite?, projectName?, file, ...describes, testTitle]
 *
 * The reporter already filters empty segments before joining with " > "
 * (see `packages/reporter/src/index.ts:buildTestDescriptor`), so the only
 * variability we care about here is whether `projectName` and `file`
 * actually appear at the start.
 */
export function parseTitleSegments(
  title: string,
  file: string,
  projectName: string | null,
): { describeChain: string[]; testTitle: string } {
  const segments = title.split(" > ");
  let start = 0;
  if (projectName && segments[start] === projectName) start += 1;
  const basename = file.includes("/") ? (file.split("/").pop() ?? file) : file;
  if (segments[start] === file || segments[start] === basename) start += 1;
  const remaining = segments.slice(start);
  if (remaining.length === 0) {
    return { describeChain: [], testTitle: title };
  }
  const testTitle = remaining[remaining.length - 1] ?? title;
  const describeChain = remaining.slice(0, -1);
  return { describeChain, testTitle };
}

export interface DescribeTestLeaf {
  kind: "test";
  test: RunProgressTest;
  displayTitle: string;
}

export interface DescribeBranch {
  kind: "describe";
  name: string;
  children: DescribeNode[];
}

export type DescribeNode = DescribeTestLeaf | DescribeBranch;

/**
 * Build a describe-block tree for the tests in a file. Tests that share a
 * describe-path prefix are collected under the same branch node; tests with
 * no describe block end up at the tree root alongside any sibling
 * describes. Input order is preserved — both for leaves within a branch
 * and for first-seen branches at each level — so callers can control
 * presentation order by pre-sorting `tests`.
 */
export function buildDescribeTree(
  tests: RunProgressTest[],
  file: string,
): DescribeNode[] {
  const root: DescribeNode[] = [];
  for (const test of tests) {
    const { describeChain, testTitle } = parseTitleSegments(
      test.title,
      file,
      test.projectName,
    );
    let siblings = root;
    for (const describeName of describeChain) {
      let branch = siblings.find(
        (n): n is DescribeBranch =>
          n.kind === "describe" && n.name === describeName,
      );
      if (!branch) {
        branch = { kind: "describe", name: describeName, children: [] };
        siblings.push(branch);
      }
      siblings = branch.children;
    }
    siblings.push({ kind: "test", test, displayTitle: testTitle });
  }
  return root;
}
