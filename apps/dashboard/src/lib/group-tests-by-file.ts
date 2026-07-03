import type { RunProgressTest } from "@/realtime/run-progress";
import {
  statusGroupKey,
  statusSortKey,
  type StatusGroupKey,
} from "@/lib/status";

/**
 * Worst-status-first severity (lower = worse). Drives both group ordering and
 * within-group row ordering. Delegates to the shared status registry
 * (`statusSortKey`) for outcome statuses; `queued` is a live-progress in-flight
 * state (not a Playwright outcome, so absent from the registry) and ranks just
 * below `flaky` / above `skipped`, between the registry's `flaky` (2) and
 * `skipped` (4) slots.
 *
 * Exported so the run-detail Tests island can order rows by the same scale it
 * groups by, instead of keeping a parallel copy of the `queued` special-case.
 */
export function severityOf(status: string): number {
  if (status === "queued") return 3;
  return statusSortKey(status);
}

/**
 * Strip the `projectName` and `file` prefixes that Playwright's
 * `test.titlePath()` bakes into the stored `title`. What's left is the
 * describe-block chain ending with the leaf test title.
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

// --- Run-detail Tests-tab engine -------------------------------------------
//
// The run-detail Tests island folds live test rows through one pipeline:
// filter (status + search) → group (by file, Playwright project, or shard,
// worst-first) → count (4-bucket collapse) → pick which groups to auto-expand.
// These pure stages live here so the island shrinks to state + presentation,
// and so the filter/group/count/auto-expand rules are unit-testable without
// rendering the island and feeding it live events.

/** Status filter chip values — `"all"` plus the four collapsed buckets. */
export type StatusFilter = "all" | StatusGroupKey;

/** Group-by axis for the Tests tab: file path, Playwright project, or shard. */
export type GroupByAxis = "file" | "project" | "shard";

/** Per-bucket counts after the `timedout → failed` / `interrupted → flaky` collapse. */
export type StatusGroupCounts = Record<StatusGroupKey, number>;

export interface GroupAndSortOptions {
  /** Free-text needle matched against title + file (case-insensitive). */
  search: string;
  /** Active status chip; `"all"` disables status filtering. */
  statusFilter: StatusFilter;
  /** Group rows by file path, Playwright project, or shard. */
  groupBy: GroupByAxis;
}

export interface GroupAndSortResult {
  /** `[groupKey, tests]` pairs, worst-group-first, rows worst-status-first. */
  groups: [string, RunProgressTest[]][];
  /** Counts over the *unfiltered* input (so the chips never hide their own bucket). */
  statusCounts: StatusGroupCounts;
  /** Group keys to expand on first paint (see `selectDefaultExpandedKeys`). */
  suggestedExpanded: Set<string>;
}

const FILE_FALLBACK_KEY = "Other";
const PROJECT_FALLBACK_KEY = "default";
const SHARD_FALLBACK_KEY = "Unsharded";

/**
 * The group key for a test row under the active axis. For `shard`, a row with a
 * shard index reads `"Shard N"` and a row without one (non-sharded run, or a
 * queued row no shard has claimed yet) falls into `"Unsharded"`.
 */
function groupKeyFor(test: RunProgressTest, groupBy: GroupByAxis): string {
  if (groupBy === "file") return test.file || FILE_FALLBACK_KEY;
  if (groupBy === "project") return test.projectName ?? PROJECT_FALLBACK_KEY;
  return test.shardIndex != null
    ? `Shard ${test.shardIndex}`
    : SHARD_FALLBACK_KEY;
}

/**
 * Count tests into the four user-facing buckets, applying the registry's
 * collapse rules (`timedout → failed`, `interrupted → flaky`). Pure.
 */
export function countByStatusGroup(
  tests: readonly RunProgressTest[],
): StatusGroupCounts {
  const counts: StatusGroupCounts = {
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
  };
  for (const test of tests) {
    const bucket = statusGroupKey(test.status);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/**
 * Filter test rows by the active status chip and search needle. A row passes
 * when its collapsed bucket matches the chip (or the chip is `"all"`) AND its
 * title or file contains the needle (case-insensitive; empty needle matches
 * everything). Pure — preserves input order.
 */
export function filterTests(
  tests: readonly RunProgressTest[],
  opts: { search: string; statusFilter: StatusFilter },
): RunProgressTest[] {
  const needle = opts.search.trim().toLowerCase();
  return tests.filter((test) => {
    if (opts.statusFilter !== "all") {
      const bucket = statusGroupKey(test.status);
      // null bucket (e.g. "queued") is excluded from every named filter
      if (bucket !== opts.statusFilter) return false;
    }
    if (
      needle &&
      !test.title.toLowerCase().includes(needle) &&
      !test.file.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Worst-group-first ordering score for a bucket of rows: `failed`-bucket rows
 * weigh 4, `flaky`-bucket rows weigh 2, everything else 0. Higher = worse =
 * earlier. Mirrors the design's "groups with the most damage float to the top",
 * which is intentionally different from single worst-status ordering (a file
 * with ten failures outranks one with a single failure).
 */
function groupSeverityScore(rows: readonly RunProgressTest[]): number {
  let score = 0;
  for (const test of rows) {
    const bucket = statusGroupKey(test.status); // null for queued — skip
    if (bucket === "failed") score += 4;
    else if (bucket === "flaky") score += 2;
  }
  return score;
}

/**
 * The run-detail Tests-tab engine: filter → group → order. Returns the ordered
 * `[key, rows]` groups (rows sorted worst-status-first), the 4-bucket counts
 * over the *unfiltered* input, and the default-expanded key set. Pure — safe to
 * call inside a `useMemo`.
 *
 * Grouping key is the file path (empty → "Other"), the Playwright project name
 * (null → "default"), or the shard ("Shard N", non-sharded → "Unsharded") — see
 * `groupKeyFor`. Groups order worst-first by `groupSeverityScore`; within a
 * group rows order worst-first by `severityOf`.
 */
export function groupAndSortTests(
  tests: readonly RunProgressTest[],
  opts: GroupAndSortOptions,
): GroupAndSortResult {
  const statusCounts = countByStatusGroup(tests);
  const filtered = filterTests(tests, opts);

  const map = new Map<string, RunProgressTest[]>();
  for (const test of filtered) {
    const key = groupKeyFor(test, opts.groupBy);
    const bucket = map.get(key);
    if (bucket) bucket.push(test);
    else map.set(key, [test]);
  }

  const groups = Array.from(map.entries());
  groups.sort((a, b) => groupSeverityScore(b[1]) - groupSeverityScore(a[1]));
  for (const [, rows] of groups) {
    rows.sort((a, b) => severityOf(a.status) - severityOf(b.status));
  }

  return {
    groups,
    statusCounts,
    suggestedExpanded: selectDefaultExpandedKeys(groups),
  };
}

/**
 * Pick the group keys to expand on first paint: among the worst-six groups,
 * any group containing a `failed`- or `flaky`-bucket test. If none qualify,
 * fall back to expanding the single worst group so the list is never fully
 * collapsed. Pure. Expects `groups` already ordered worst-first.
 */
export function selectDefaultExpandedKeys(
  groups: readonly [string, readonly RunProgressTest[]][],
): Set<string> {
  const expanded = new Set<string>();
  for (const [key, rows] of groups.slice(0, 6)) {
    if (
      rows.some((test) => {
        const bucket = statusGroupKey(test.status); // null for queued — skip
        return bucket === "failed" || bucket === "flaky";
      })
    ) {
      expanded.add(key);
    }
  }
  if (expanded.size === 0 && groups[0]) expanded.add(groups[0][0]);
  return expanded;
}
