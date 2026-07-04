import type { RunProgressTest } from "@/realtime/run-progress";
import { statusGroupKey, type StatusGroupKey } from "@/lib/status";

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

// --- Run-detail Tests-tab helpers ------------------------------------------
//
// The Tests tab groups + counts + orders a run's rows SERVER-side
// (`loadRunGroupSkeleton`) and paginates each group's rows lazily. These pure
// client helpers cover the pieces the island still owns: the status/search
// filter applied to the live overlay, the group-by axis type, and the
// raw-key ↔ identity ↔ label contract that ties a streamed row to its
// server-built header.

/** Status filter chip values — `"all"` plus the four collapsed buckets. */
export type StatusFilter = "all" | StatusGroupKey;

/** Group-by axis for the Tests tab: file path, Playwright project, or shard. */
export type GroupByAxis = "file" | "project" | "shard";

const FILE_FALLBACK_KEY = "Other";
const PROJECT_FALLBACK_KEY = "default";
const SHARD_FALLBACK_KEY = "Unsharded";

/**
 * The RAW grouping value for a row under the active axis — matching the group
 * SKELETON's `key` (`loadRunGroupSkeleton`), so a live-streamed row folds into
 * the right server-built header. Returns the canonical value the row query
 * filters on: the `file` string (empty → `""`, never null since the column is
 * NOT NULL), `projectName` (nullable), or `shardIndex` as a decimal string
 * (nullable). See `groupLabel` for the display form.
 */
export function rawGroupKey(
  test: RunProgressTest,
  groupBy: GroupByAxis,
): string | null {
  if (groupBy === "file") return test.file;
  if (groupBy === "project") return test.projectName ?? null;
  return test.shardIndex != null ? String(test.shardIndex) : null;
}

/**
 * A stable, collision-free client identity for a raw group key (which may be
 * `null` for a fallback group). Used as the React key and the `expanded` Set
 * member. The sentinel can't collide with a real key: `null` only occurs on
 * the nullable project/shard axes, whose real keys are project names / decimal
 * strings.
 */
export function groupKeyId(key: string | null): string {
  return key ?? " __null__";
}

/** The human label for a raw group key under an axis (fallbacks included). */
export function groupLabel(axis: GroupByAxis, key: string | null): string {
  if (axis === "file") return key && key.length > 0 ? key : FILE_FALLBACK_KEY;
  if (axis === "project") return key ?? PROJECT_FALLBACK_KEY;
  return key === null ? SHARD_FALLBACK_KEY : `Shard ${key}`;
}

/** Per-bucket test counts for a single group (see `worstStatusInGroup`). */
export type StatusGroupCounts = Record<StatusGroupKey, number>;

/**
 * The worst-status bucket present in a group's counts, for the group-header
 * status glyph — the single-glyph "how did this file / project / shard do"
 * summary. Order is `failed` → `flaky` → `passed` → `skipped`. This
 * deliberately ranks `skipped` *below* `passed` (unlike the app-wide
 * `statusSortKey`, where skipped outranks passed): a group with even one real
 * result should read as that result, not "skipped", so skipped only wins when
 * the group is entirely skipped. Returns null only when every bucket is zero
 * (e.g. a group of only in-flight `queued` rows). Pure.
 */
export function worstStatusInGroup(
  counts: StatusGroupCounts,
): StatusGroupKey | null {
  const worstFirst: StatusGroupKey[] = ["failed", "flaky", "passed", "skipped"];
  for (const bucket of worstFirst) {
    if (counts[bucket] > 0) return bucket;
  }
  return null;
}

/**
 * Filter test rows by the active status chip and search needle. A row passes
 * when its collapsed bucket matches the chip (or the chip is `"all"`) AND its
 * title or file contains the needle (case-insensitive; empty needle matches
 * everything). Pure — preserves input order.
 *
 * Applied client-side to the live `byId` overlay so it matches the active view
 * — the server already applies the equivalent status/search filter to the rows
 * it paginates in (see `loadRunResultsPage`).
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
