import { ChevronDown, ChevronRight, SearchIcon } from "lucide-react";
import { Link } from "@void/react";
import { useEffect, useMemo, useState } from "react";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/segmented-control";
import { StatusGlyph } from "@/components/status-glyph";
import { cn } from "@/lib/cn";
import {
  useRunProgress,
  type RunProgressSummary,
  type RunProgressTest,
} from "@/lib/live-client";
import { formatDuration } from "@/lib/time-format";

interface RunProgressProps {
  /** Run id used as the `void/live` topic suffix (`run:<runId>`). */
  runId: string;
  /** Team slug — used to build test-detail href on row click. */
  teamSlug: string;
  /** Project slug — same as above. */
  projectSlug: string;
  /** SSR-loaded test rows. Forwarded to the hook to seed its accumulator. */
  initialTests?: RunProgressTest[];
  /** SSR-loaded aggregate. Forwarded to the hook so counts render pre-event. */
  initialSummary?: RunProgressSummary;
}

type StatusFilter = "all" | "passed" | "failed" | "flaky" | "skipped";
type GroupBy = "file" | "project";

const STATUS_ORDER: Record<string, number> = {
  failed: 0,
  timedout: 1,
  flaky: 2,
  queued: 3,
  skipped: 4,
  passed: 5,
};

/**
 * Run-detail Tests tab. Subscribes to live progress events for `run:<runId>`
 * via `useRunProgress`, merging streaming updates on top of the SSR-loaded
 * `initialTests`/`initialSummary`.
 *
 * Layout mirrors the design bundle's `screen-run-detail.jsx`:
 *   - Sticky filter bar — search input, status SegmentedControl with per-status
 *     counts, Group-by control (File / Playwright project).
 *   - Grouped collapsible list — each group header shows the file path or
 *     project name plus a per-status count summary; click to toggle. Failed /
 *     flaky groups expand by default.
 *   - Each row is a `<Link>` to the test-detail page (whole row clickable).
 *
 * Tags from the design's `TestRow` aren't shown — `RunProgressTest` doesn't
 * carry them today (testTags table is keyed by `testResultId` and not joined
 * into the live progress payload). Easy to add later by extending the wire
 * format if/when it becomes load-bearing.
 */
export function RunProgress({
  runId,
  teamSlug,
  projectSlug,
  initialTests,
  initialSummary,
}: RunProgressProps) {
  const { byId, summary: _summary } = useRunProgress(runId, {
    initialTests,
    initialSummary,
  });
  const tests = useMemo(() => Object.values(byId), [byId]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("file");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [didAutoExpand, setDidAutoExpand] = useState(false);

  // Per-status counts feed the SegmentedControl labels — re-compute from the
  // live accumulator each render so they stay in sync with streaming updates.
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    };
    for (const t of tests) {
      const key = t.status === "timedout" ? "failed" : t.status;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [tests]);

  const filtered = useMemo(() => {
    return tests.filter((t) => {
      if (statusFilter !== "all") {
        if (statusFilter === "failed") {
          if (t.status !== "failed" && t.status !== "timedout") return false;
        } else if (t.status !== statusFilter) {
          return false;
        }
      }
      if (search) {
        const needle = search.toLowerCase();
        if (
          !t.title.toLowerCase().includes(needle) &&
          !t.file.toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [tests, statusFilter, search]);

  // Group → tests, then sort groups by worst-status-first like the design.
  const groups = useMemo(() => {
    const map = new Map<string, RunProgressTest[]>();
    for (const t of filtered) {
      const key =
        groupBy === "file" ? t.file || "Other" : (t.projectName ?? "default");
      const bucket = map.get(key) ?? [];
      bucket.push(t);
      map.set(key, bucket);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const score = (rows: RunProgressTest[]) =>
        rows.reduce((s, t) => {
          if (t.status === "failed" || t.status === "timedout") return s + 4;
          if (t.status === "flaky") return s + 2;
          return s;
        }, 0);
      return score(b[1]) - score(a[1]);
    });
    return entries;
  }, [filtered, groupBy]);

  // Auto-expand the worst-status groups on first render. Tracks separately so
  // user toggles after the first interaction stick around.
  useEffect(() => {
    if (didAutoExpand || groups.length === 0) return;
    const next = new Set<string>();
    for (const [key, items] of groups.slice(0, 6)) {
      if (
        items.some(
          (t) =>
            t.status === "failed" ||
            t.status === "timedout" ||
            t.status === "flaky",
        )
      ) {
        next.add(key);
      }
    }
    if (next.size === 0 && groups[0]) next.add(groups[0][0]);
    setExpanded(next);
    setDidAutoExpand(true);
  }, [groups, didAutoExpand]);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const statusOptions: SegmentedOption<StatusFilter>[] = [
    { value: "all", label: "All", count: tests.length },
    {
      value: "failed",
      label: "Failed",
      count: statusCounts.failed ?? 0,
      dot: "failed",
    },
    {
      value: "flaky",
      label: "Flaky",
      count: statusCounts.flaky ?? 0,
      dot: "flaky",
    },
    {
      value: "passed",
      label: "Passed",
      count: statusCounts.passed ?? 0,
      dot: "passed",
    },
    {
      value: "skipped",
      label: "Skipped",
      count: statusCounts.skipped ?? 0,
      dot: "skipped",
    },
  ];

  return (
    /* Filter bar is sticky relative to the page-level scroller in
     * `pages/.../runs/[runId]/index.tsx`. `top-[84px]` clears the sticky H1
     * row (52px) plus the sticky tab bar (~32px) so the filter controls
     * sit just below them rather than overlapping. */
    <div className="flex flex-col">
      <div className="sticky top-[84px] z-10 flex flex-wrap items-center gap-2 border-b border-line-1 bg-background px-6 py-2.5">
        <div className="relative w-[260px]">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="Filter tests"
            className="h-7 w-full rounded-md border border-line-1 bg-card pl-8 pr-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tests…"
            type="search"
            value={search}
          />
        </div>

        <SegmentedControl
          onChange={setStatusFilter}
          options={statusOptions}
          value={statusFilter}
        />

        <div className="flex-1" />

        <span className="text-[12px] text-fg-3">Group by</span>
        <SegmentedControl
          compact
          onChange={setGroupBy}
          options={[
            { value: "file", label: "File" },
            { value: "project", label: "Playwright project" },
          ]}
          value={groupBy}
        />
      </div>

      <div>
        {groups.length === 0 ? (
          <div className="px-6 py-10 text-center text-[12.5px] text-muted-foreground">
            {tests.length === 0
              ? "No tests recorded for this run."
              : "No tests match the current filters."}
          </div>
        ) : (
          groups.map(([key, items]) => (
            <TestGroup
              groupBy={groupBy}
              groupKey={key}
              key={key}
              onToggle={() => toggleGroup(key)}
              open={expanded.has(key)}
              projectSlug={projectSlug}
              runId={runId}
              teamSlug={teamSlug}
              tests={items}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TestGroup({
  groupKey,
  groupBy,
  tests,
  open,
  onToggle,
  teamSlug,
  projectSlug,
  runId,
}: {
  groupKey: string;
  groupBy: GroupBy;
  tests: RunProgressTest[];
  open: boolean;
  onToggle: () => void;
  teamSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    };
    for (const t of tests) {
      const key = t.status === "timedout" ? "failed" : t.status;
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [tests]);

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
        {groupBy === "file" ? (
          <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
            {groupKey}
          </span>
        ) : (
          <span className="truncate text-[13px] font-medium text-foreground">
            {groupKey}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-fg-3">
          {tests.length}
        </span>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] tabular-nums">
          {counts.failed > 0 ? (
            <span style={{ color: "var(--fail)" }}>{counts.failed}f</span>
          ) : null}
          {counts.flaky > 0 ? (
            <span style={{ color: "var(--flaky)" }}>{counts.flaky}~</span>
          ) : null}
          {counts.skipped > 0 ? (
            <span style={{ color: "var(--skipped)" }}>{counts.skipped}s</span>
          ) : null}
          <span style={{ color: "var(--pass)" }}>{counts.passed ?? 0}p</span>
        </div>
      </button>

      {open ? (
        <div>
          {[...tests]
            .sort(
              (a, b) =>
                (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99),
            )
            .map((t) => (
              <TestRow
                key={t.id}
                projectSlug={projectSlug}
                runId={runId}
                teamSlug={teamSlug}
                test={t}
              />
            ))}
        </div>
      ) : null}
    </div>
  );
}

function TestRow({
  test,
  teamSlug,
  projectSlug,
  runId,
}: {
  test: RunProgressTest;
  teamSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const href = `/t/${teamSlug}/p/${projectSlug}/runs/${runId}/tests/${test.id}?attempt=0`;
  // Strip the file-path prefix that the reporter sometimes bakes into the
  // stored title (`tests/foo.spec.ts > describe > test`). Display the rest.
  let displayTitle = test.title;
  if (test.file) {
    const prefix = `${test.file} > `;
    if (displayTitle.startsWith(prefix))
      displayTitle = displayTitle.slice(prefix.length);
  }

  return (
    <Link
      className={cn(
        "group flex w-full items-center gap-1 py-1.5 pl-[50px] pr-6",
        "min-h-[var(--row-h-dense)] text-left text-foreground hover:bg-bg-1",
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
            style={{ color: "var(--flaky)" }}
          >
            ×{test.retryCount + 1}
          </span>
        ) : null}
      </div>
      <span className="w-[60px] shrink-0 px-2 font-mono text-[11px] capitalize text-fg-3">
        {test.projectName ?? ""}
      </span>
      <span className="w-[70px] shrink-0 px-2 text-right font-mono text-[12px] tabular-nums text-fg-3">
        {formatDuration(test.durationMs)}
      </span>
      <span className="w-5 shrink-0 px-1 text-center text-fg-3 opacity-0 group-hover:opacity-100">
        <ChevronRight className="size-3" strokeWidth={2} />
      </span>
    </Link>
  );
}
