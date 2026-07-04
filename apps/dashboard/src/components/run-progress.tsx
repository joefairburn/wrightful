"use client";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Link } from "@void/react";
import { fetch } from "void/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchFilterInput } from "@/components/search-filter-input";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/segmented-control";
import { StatusGlyph } from "@/components/status-glyph";
import { cn } from "@/lib/cn";
import {
  filterTests,
  type GroupByAxis,
  groupKeyId,
  groupLabel,
  parseTitleSegments,
  rawGroupKey,
  type StatusFilter,
  worstStatusInGroup,
} from "@/lib/group-tests-by-file";
import type { RunGroupHeader, RunGroupSkeleton } from "@/lib/run-groups-page";
import type { RunResultsResponse } from "@/lib/run-results-page";
import { statusToken } from "@/lib/status";
import {
  currentSummary,
  type RunProgressSummary,
  type RunProgressTest,
} from "@/realtime/run-progress";
import { useRunRoom } from "@/realtime/use-run-room";
import { formatDuration } from "@/lib/time-format";

interface RunProgressProps {
  /** Run id used as the `void/ws` run-room key (`run:<runId>`). */
  runId: string;
  /** Team slug — used to build test-detail hrefs + the API paths. */
  teamSlug: string;
  /** Project slug — same as above. */
  projectSlug: string;
  /** Group-by axis the SSR skeleton was built for (the default first paint). */
  initialGroupBy: GroupByAxis;
  /** SSR-loaded worst-first group headers + per-bucket counts. */
  initialSkeleton: RunGroupSkeleton;
  /**
   * SSR-loaded first row page for each auto-expanded group, keyed by
   * `groupKeyId`. Seeds the per-group infinite query so the worst groups paint
   * populated with no client round-trip.
   */
  initialExpandedGroups: Record<string, RunResultsResponse>;
  /** SSR run aggregate — seeds the live filter-chip counts (whole-run, exact). */
  initialSummary: RunProgressSummary;
  /** Whether the run is sharded — gates the "Shard" group-by option. */
  isSharded: boolean;
}

/** A running run's skeleton stays fresh this long; live events refresh it at most this often. */
const LIVE_STALE_MS = 5_000;
/** Debounce for the search box before it drives the (server) queries. */
const SEARCH_DEBOUNCE_MS = 300;

const EMPTY_ROWS: readonly RunProgressTest[] = [];

/** The group keys the server flagged to auto-expand on first paint. */
function defaultExpandedIds(skeleton: RunGroupSkeleton): Set<string> {
  const ids = new Set<string>();
  for (const g of skeleton.groups) {
    if (g.expandedByDefault) ids.add(groupKeyId(g.key));
  }
  return ids;
}

/** Whether a skeleton carries any failed/flaky-bucket group (a "bad" group). */
function hasBadGroup(skeleton: RunGroupSkeleton): boolean {
  return skeleton.groups.some((g) => g.failed > 0 || g.flaky > 0);
}

/**
 * Run-detail Tests tab. Two-level, paginated-by-group:
 *
 *   - Filter chips (All/Failed/Flaky/Passed/Skipped) read the **whole-run**
 *     aggregate from the live `void/ws` summary (`useRunRoom`), so they are
 *     instant + correct + live without loading a single row.
 *   - The grouped list renders a server-built **skeleton** (worst-first headers
 *     with per-bucket counts) fetched once via TanStack `useQuery`; changing the
 *     group-by axis / status chip / search re-fetches it server-side.
 *   - Each group's ROWS are fetched lazily on expand via `useInfiniteQuery`
 *     (infinite-scroll for a huge group), merged on top of the live `byId`
 *     overlay and sorted worst-first client-side.
 *
 * This replaces the old "back-paginate the whole run into memory, derive
 * everything client-side" model (the source of the DB-flooding 200→2000 count
 * tick). Terminal runs cache their skeleton/rows indefinitely; a running run
 * refreshes the (cheap) skeleton on a throttled cadence as results stream.
 *
 * Three count surfaces coexist by design and are only eventually-consistent on
 * a live run: the filter CHIPS read the whole-run WS `summary` (authoritative
 * for the run total); the group HEADERS read the skeleton snapshot (may lag by
 * up to ~LIVE_STALE_MS while running); the ROWS in an expanded group are what's
 * paginated in plus the live `byId` overlay. At rest (terminal run) all three
 * agree — they derive their buckets from the same `STATUS_BUCKET_MEMBERS`.
 */
export function RunProgress({
  runId,
  teamSlug,
  projectSlug,
  initialGroupBy,
  initialSkeleton,
  initialExpandedGroups,
  initialSummary,
  isSharded,
}: RunProgressProps) {
  const state = useRunRoom(runId, { initialSummary });
  const summary = currentSummary(state, initialSummary);
  const byId = state.byId;
  const isRunning = summary.status === "running";

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupByAxis>(initialGroupBy);
  // Computed once from the stable SSR prop, feeding both the initial expanded
  // set and the auto-expand latch (no double scan).
  const initialExpanded = useMemo(
    () => defaultExpandedIds(initialSkeleton),
    [initialSkeleton],
  );
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);
  const didAutoExpand = useRef(initialExpanded.size > 0);
  // A run seeded with groups at SSR (terminal / reloaded mid-run) auto-expands
  // immediately; a run watched live from empty must not consume the latch on a
  // passing fallback group (see the auto-expand effect).
  const seededNonEmpty = useRef(initialSkeleton.groups.length > 0);

  // Debounce the search box: the input stays responsive while the (server)
  // skeleton + row queries key off the settled value.
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [search]);

  // The default view = the axis/filters the SSR seed covers, so its query can
  // hydrate from `initialSkeleton` / `initialExpandedGroups` with no fetch.
  const isDefaultView =
    groupBy === initialGroupBy &&
    statusFilter === "all" &&
    debouncedSearch === "";

  const queryClient = useQueryClient();

  const skeletonQuery = useQuery({
    queryKey: ["run-groups", runId, groupBy, statusFilter, debouncedSearch],
    queryFn: ({ signal }): Promise<RunGroupSkeleton> =>
      fetch("/api/t/:teamSlug/p/:projectSlug/runs/:runId/groups", {
        params: { teamSlug, projectSlug, runId },
        query: {
          groupBy,
          ...(statusFilter !== "all" ? { status: statusFilter } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
        },
        signal,
      }),
    initialData: isDefaultView ? initialSkeleton : undefined,
    staleTime: isRunning ? LIVE_STALE_MS : Number.POSITIVE_INFINITY,
  });
  const skeleton = skeletonQuery.data;

  // Live skeleton refresh — THROTTLED to at most once per LIVE_STALE_MS and
  // driven by actual `byId` events. A plain trailing debounce starves under
  // sustained streaming (the timer keeps resetting and never fires); a fixed
  // interval would poll forever if a terminal event were missed (isRunning stuck
  // true). Keying off events means no events ⇒ no refetch. The mount pass is
  // skipped so the SSR seed isn't discarded. Terminal runs skip this entirely
  // (counts frozen); expanded groups update via the `byId` overlay regardless.
  const lastSkeletonRefresh = useRef(0);
  const skeletonMountSkipped = useRef(false);
  useEffect(() => {
    if (!isRunning) return;
    if (!skeletonMountSkipped.current) {
      skeletonMountSkipped.current = true;
      lastSkeletonRefresh.current = Date.now();
      return;
    }
    const refresh = () => {
      lastSkeletonRefresh.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: ["run-groups", runId] });
    };
    const since = Date.now() - lastSkeletonRefresh.current;
    if (since >= LIVE_STALE_MS) {
      refresh();
      return;
    }
    const t = setTimeout(refresh, LIVE_STALE_MS - since);
    return () => clearTimeout(t);
  }, [byId, isRunning, runId, queryClient]);

  // One final skeleton refresh when the run finishes, so the headers reflect the
  // terminal state even if the last batch landed inside the throttle window.
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      void queryClient.invalidateQueries({ queryKey: ["run-groups", runId] });
    }
    wasRunning.current = isRunning;
  }, [isRunning, runId, queryClient]);

  // On a WS reconnect, useRunRoom's reseed resets the live `byId` overlay and the
  // loader re-runs with a fresh `initialSummary` identity — but TanStack caches
  // aren't touched by that loader refresh, so re-hydrate the skeleton +
  // open-group rows the reset overlay dropped. Skips the mount pass (the SSR
  // seed is already fresh).
  const seededSummary = useRef(initialSummary);
  useEffect(() => {
    if (seededSummary.current === initialSummary) return;
    seededSummary.current = initialSummary;
    void queryClient.invalidateQueries({ queryKey: ["run-groups", runId] });
    void queryClient.invalidateQueries({ queryKey: ["run-group-rows", runId] });
  }, [initialSummary, runId, queryClient]);

  // One-shot auto-expand of the worst groups (server-flagged `expandedByDefault`).
  // A run seeded non-empty (terminal / reloaded) latches on first paint; a run
  // watched live from empty must NOT consume the latch on the fallback expansion
  // of a passing group — wait for a real failed/flaky group, or later-failing
  // groups would never auto-expand. Re-runs per axis (onGroupBy resets the latch;
  // `groupBy` in deps covers a switch to a cached axis).
  useEffect(() => {
    if (didAutoExpand.current || !skeleton) return;
    const def = defaultExpandedIds(skeleton);
    if (def.size === 0) return;
    if (!seededNonEmpty.current && !hasBadGroup(skeleton)) return;
    setExpanded(def);
    didAutoExpand.current = true;
  }, [skeleton, groupBy]);

  // Group the live overlay once per event (O(byId)), so each group reads its
  // own slice instead of re-scanning all of `byId`.
  const liveByGroup = useMemo(() => {
    const m = new Map<string, RunProgressTest[]>();
    for (const t of Object.values(byId)) {
      const id = groupKeyId(rawGroupKey(t, groupBy));
      const arr = m.get(id);
      if (arr) arr.push(t);
      else m.set(id, [t]);
    }
    return m;
  }, [byId, groupBy]);

  function onGroupBy(next: GroupByAxis) {
    if (next === groupBy) return;
    setGroupBy(next);
    // Re-auto-expand for the new axis: its keys differ, so drop manual state.
    didAutoExpand.current = false;
    setExpanded(new Set());
  }

  function toggleGroup(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const statusOptions: SegmentedOption<StatusFilter>[] = [
    { value: "all", label: "All", count: summary.totalTests },
    { value: "failed", label: "Failed", count: summary.failed, dot: "failed" },
    { value: "flaky", label: "Flaky", count: summary.flaky, dot: "flaky" },
    { value: "passed", label: "Passed", count: summary.passed, dot: "passed" },
    {
      value: "skipped",
      label: "Skipped",
      count: summary.skipped,
      dot: "skipped",
    },
  ];

  const groups = skeleton?.groups ?? [];

  return (
    <div className="flex flex-col">
      <div className="sticky top-[84px] z-10 flex flex-wrap items-center gap-2 border-b border-line-1 bg-background px-6 py-2.5">
        <SearchFilterInput
          aria-label="Filter tests"
          className="w-[260px]"
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter tests…"
          value={search}
        />

        <SegmentedControl
          onChange={setStatusFilter}
          options={statusOptions}
          value={statusFilter}
        />

        <div className="flex-1" />

        <span className="text-[12px] text-fg-3">Group by</span>
        <SegmentedControl
          compact
          onChange={onGroupBy}
          options={[
            { value: "file", label: "File" },
            { value: "project", label: "Playwright project" },
            ...(isSharded ? [{ value: "shard" as const, label: "Shard" }] : []),
          ]}
          value={groupBy}
        />
      </div>

      <div>
        {groups.length === 0 ? (
          <div className="px-6 py-10 text-center text-[12.5px] text-muted-foreground">
            {skeletonQuery.isPending
              ? "Loading tests…"
              : summary.totalTests === 0
                ? "No tests recorded for this run."
                : "No tests match the current filters."}
          </div>
        ) : (
          groups.map((header) => {
            const id = groupKeyId(header.key);
            return (
              <TestGroup
                debouncedSearch={debouncedSearch}
                groupBy={groupBy}
                header={header}
                initialPage={
                  isDefaultView ? initialExpandedGroups[id] : undefined
                }
                isRunning={isRunning}
                key={id}
                liveRows={liveByGroup.get(id) ?? EMPTY_ROWS}
                onToggle={() => toggleGroup(id)}
                open={expanded.has(id)}
                projectSlug={projectSlug}
                runId={runId}
                statusFilter={statusFilter}
                teamSlug={teamSlug}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function TestGroup({
  header,
  groupBy,
  open,
  onToggle,
  teamSlug,
  projectSlug,
  runId,
  statusFilter,
  debouncedSearch,
  liveRows,
  initialPage,
  isRunning,
}: {
  header: RunGroupHeader;
  groupBy: GroupByAxis;
  open: boolean;
  onToggle: () => void;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  statusFilter: StatusFilter;
  debouncedSearch: string;
  liveRows: readonly RunProgressTest[];
  initialPage: RunResultsResponse | undefined;
  isRunning: boolean;
}) {
  const rawKey = header.key;
  const id = groupKeyId(rawKey);

  const rowsQuery = useInfiniteQuery({
    queryKey: [
      "run-group-rows",
      runId,
      groupBy,
      id,
      statusFilter,
      debouncedSearch,
    ],
    queryFn: ({ pageParam, signal }): Promise<RunResultsResponse> =>
      fetch("/api/t/:teamSlug/p/:projectSlug/runs/:runId/results", {
        params: { teamSlug, projectSlug, runId },
        query: {
          groupBy,
          ...(rawKey !== null ? { groupKey: rawKey } : {}),
          ...(statusFilter !== "all" ? { statusBucket: statusFilter } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
    initialData: initialPage
      ? { pages: [initialPage], pageParams: [null] }
      : undefined,
    staleTime: isRunning ? LIVE_STALE_MS : Number.POSITIVE_INFINITY,
  });

  // Merge the paginated server rows with the live overlay (existing-id-wins,
  // so a test finishing mid-view replaces its fetched row), filter the live
  // rows to the active chip/search (the server already filtered the fetched
  // ones), then order by id descending. id (a ULID) is monotonic with insert
  // time, so this exactly matches the server's `(createdAt DESC, id DESC)`
  // pagination order — display order == fetch order, so a newly-loaded page
  // never reorders rows above the scroll position. (Worst-first is preserved at
  // the GROUP level via the skeleton order, not within a group.)
  const rows = useMemo(() => {
    const fetched = (rowsQuery.data?.pages ?? []).flatMap((p) => p.results);
    const live = filterTests(liveRows, {
      search: debouncedSearch,
      statusFilter,
    });
    const map = new Map<string, RunProgressTest>();
    for (const r of fetched) map.set(r.id, r);
    for (const r of live) map.set(r.id, r);
    return [...map.values()].sort((a, b) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
  }, [rowsQuery.data, liveRows, debouncedSearch, statusFilter]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = rowsQuery;
  useEffect(() => {
    if (!open || !hasNextPage) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const label = groupLabel(groupBy, rawKey);
  // Single-glyph rollup of the group's worst status; null when all in-flight.
  // Derived from the server-computed header counts (the paginated group no
  // longer holds the full test list client-side).
  const worst = worstStatusInGroup(header);

  return (
    <div className="border-b border-line-1">
      <button
        className="flex w-full items-center gap-2 px-6 py-2 text-left hover:bg-bg-1"
        onClick={onToggle}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-fg-3" strokeWidth={2} />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-fg-3" strokeWidth={2} />
        )}
        {worst ? (
          <span className="flex shrink-0 items-center justify-center">
            <StatusGlyph size={13} status={worst} />
          </span>
        ) : null}
        {groupBy === "file" ? (
          <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
            {label}
          </span>
        ) : (
          <span className="truncate text-[13px] font-medium text-foreground">
            {label}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-fg-3">
          {header.total}
        </span>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] tabular-nums">
          {header.failed > 0 ? (
            <span style={{ color: statusToken("failed") }}>
              {header.failed}f
            </span>
          ) : null}
          {header.flaky > 0 ? (
            <span style={{ color: statusToken("flaky") }}>{header.flaky}~</span>
          ) : null}
          {header.skipped > 0 ? (
            <span style={{ color: statusToken("skipped") }}>
              {header.skipped}s
            </span>
          ) : null}
          <span style={{ color: statusToken("passed") }}>{header.passed}p</span>
        </div>
      </button>

      {open ? (
        <div>
          {rows.map((t) => (
            <TestRow
              groupBy={groupBy}
              key={t.id}
              projectSlug={projectSlug}
              runId={runId}
              teamSlug={teamSlug}
              test={t}
            />
          ))}
          {rowsQuery.isPending && rows.length === 0 ? (
            <div className="flex items-center gap-2 py-3 pl-[50px] pr-6 text-[12px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" strokeWidth={2} />
              Loading…
            </div>
          ) : null}
          {hasNextPage ? (
            <div
              className="flex items-center gap-2 py-2 pl-[50px] pr-6 text-[12px] text-muted-foreground"
              ref={sentinelRef}
            >
              {isFetchingNextPage ? (
                <>
                  <Loader2 className="size-3 animate-spin" strokeWidth={2} />
                  Loading more…
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TestRow({
  test,
  groupBy,
  teamSlug,
  projectSlug,
  runId,
}: {
  test: RunProgressTest;
  groupBy: GroupByAxis;
  teamSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const href = `/t/${teamSlug}/p/${projectSlug}/runs/${runId}/tests/${test.id}?attempt=0`;
  // The stored title is Playwright's `titlePath`: `[project >] file > describe… >
  // test`. Parse it down to just the describe chain + leaf title so the project
  // and file don't leak into the row's `>` chain — they're already surfaced by
  // the group header and the trailing meta column, not repeated here.
  const { describeChain, testTitle } = parseTitleSegments(
    test.title,
    test.file,
    test.projectName,
  );
  const displayTitle =
    describeChain.length > 0
      ? `${describeChain.join(" > ")} > ${testTitle}`
      : testTitle;

  // Trailing meta shows the axis that ISN'T the group header: the Playwright
  // project when grouped by file, the file basename when grouped by project.
  const meta =
    groupBy === "file"
      ? test.projectName
      : test.file
        ? (test.file.split("/").pop() ?? test.file)
        : null;

  return (
    <Link
      className={cn(
        "group flex w-full items-center gap-1 py-1.5 pl-[50px] pr-6",
        "min-h-8 text-left text-foreground hover:bg-bg-1",
      )}
      href={href}
    >
      <span className="flex w-[18px] shrink-0 items-center justify-center">
        <StatusGlyph size={12} status={test.status} />
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <span className="min-w-0 truncate text-[12.5px]">{displayTitle}</span>
        {test.retryCount > 0 ? (
          <span
            className="shrink-0 font-mono text-[10.5px]"
            style={{ color: statusToken("flaky") }}
          >
            ×{test.retryCount + 1}
          </span>
        ) : null}
      </div>
      {meta ? (
        <span
          className={cn(
            "inline-flex max-w-[128px] shrink-0 items-center rounded-[4px] bg-bg-2 px-1.5 py-px font-mono text-[10.5px] leading-[16px] text-fg-3",
            groupBy === "file" && "capitalize",
          )}
          title={meta}
        >
          <span className="truncate">{meta}</span>
        </span>
      ) : null}
      <span className="w-[70px] shrink-0 px-2 text-right font-mono text-[12px] tabular-nums text-fg-3">
        {formatDuration(test.durationMs)}
      </span>
      <span className="w-5 shrink-0 px-1 text-center text-fg-3 opacity-0 group-hover:opacity-100">
        <ChevronRight className="size-3" strokeWidth={2} />
      </span>
    </Link>
  );
}
