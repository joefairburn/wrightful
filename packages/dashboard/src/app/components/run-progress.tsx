"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useSyncedState } from "rwsdk/use-synced-state/client";
import {
  Check,
  ChevronDown,
  CircleSlash,
  FileCode,
  Minus,
  TriangleAlert,
  X,
  Circle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTriggerRaw,
} from "@/app/components/ui/accordion";
import { RunTestsPopover } from "@/app/components/run-tests-popover";
import { TestErrorAlert } from "@/app/components/test-error-alert";
import {
  ArtifactActions,
  type ArtifactAction,
} from "@/app/components/artifact-actions";
import {
  buildDescribeTree,
  groupTestsByFile,
  type DescribeNode,
  type FileGroup,
} from "@/lib/group-tests-by-file";
import type {
  RunProgressTest,
  RunProgressTestStatus,
  RunSummary,
  RunTestsTail,
} from "@/routes/api/progress";

const RESULT_STATUS_ORDER: Record<string, number> = {
  failed: 0,
  timedout: 1,
  flaky: 2,
  passed: 3,
  skipped: 4,
  queued: 5,
};

const FILTER_VALUES = ["passed", "failed", "flaky"] as const;
type TestStatusFilter = (typeof FILTER_VALUES)[number];
const statusFilterParser = parseAsStringLiteral(FILTER_VALUES);

/** URL-synced filter for the summary tiles. `null` = show all. */
function useStatusFilter() {
  return useQueryState("status", statusFilterParser);
}

/** Does a filter bucket include the given test status? `null` = include all. */
function matchesFilter(
  status: RunProgressTestStatus,
  filter: TestStatusFilter | null,
): boolean {
  if (filter === null) return true;
  if (filter === "failed") return status === "failed" || status === "timedout";
  return status === filter;
}

const FILTER_EMPTY_LABEL: Record<TestStatusFilter, string> = {
  passed: "No passing tests in this run.",
  failed: "No failing tests in this run.",
  flaky: "No flaky tests in this run.",
};

function StatusIcon({ status }: { status: RunProgressTestStatus }) {
  const size = 14;
  const stroke = 3;
  if (status === "passed")
    return <Check size={size} strokeWidth={stroke} className="text-success" />;
  if (status === "failed" || status === "timedout")
    return <X size={size} strokeWidth={stroke} className="text-destructive" />;
  if (status === "flaky")
    return (
      <TriangleAlert size={size} strokeWidth={2.5} className="text-warning" />
    );
  if (status === "skipped")
    return (
      <Minus size={size} strokeWidth={2.5} className="text-muted-foreground" />
    );
  if (status === "queued")
    return (
      <Circle
        size={size}
        strokeWidth={2}
        className="text-muted-foreground/60"
      />
    );
  return (
    <CircleSlash
      size={size}
      strokeWidth={2}
      className="text-muted-foreground"
    />
  );
}

function SummaryTile({
  label,
  value,
  accent,
  tone,
  isActive,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
  tone?: "success" | "destructive" | "warning";
  isActive?: boolean;
  onClick?: () => void;
}) {
  const border =
    tone === "success"
      ? "border-t-success"
      : tone === "destructive"
        ? "border-t-destructive"
        : tone === "warning"
          ? "border-t-warning"
          : "border-t-border";
  const text =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "warning"
          ? "text-warning"
          : "text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive ?? false}
      className={cn(
        "rounded-md bg-background px-3 py-2.5 border border-border/60 text-left w-full transition-colors cursor-pointer outline-none",
        "hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring",
        accent && `border-t-2 ${border}`,
        isActive && "bg-muted/40 ring-2 ring-ring/30",
      )}
    >
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </div>
      <div className={cn("font-mono text-xl tabular-nums", text)}>{value}</div>
    </button>
  );
}

// Each describe level adds ~18px of left indent to the row (stacking under
// the file header's chevron+icon gutter). Pure function so it's easy to
// tweak from one place.
function indentPaddingLeft(depth: number): string {
  return `${20 + depth * 18}px`;
}

function TestRow({
  test,
  displayTitle,
  depth,
  href,
  expandError,
  artifactActions,
}: {
  test: RunProgressTest;
  displayTitle: string;
  depth: number;
  href: string | null;
  expandError: boolean;
  artifactActions?: ArtifactAction[];
}) {
  const isFailure = test.status === "failed" || test.status === "timedout";
  const showError = isFailure && test.errorMessage && expandError;
  const body = (
    <>
      <StatusIcon status={test.status} />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span
          className={cn(
            "text-sm truncate",
            test.status === "queued"
              ? "text-muted-foreground"
              : "text-foreground",
          )}
        >
          {displayTitle}
        </span>
        {test.retryCount > 0 && (
          <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-sm border border-warning/30 bg-warning/10 text-warning font-mono text-[10px]">
            Retry {test.retryCount}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 shrink-0">
        {test.projectName ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[10px] text-muted-foreground">
            {test.projectName}
          </span>
        ) : null}
        <span className="font-mono text-xs tabular-nums text-muted-foreground w-14 text-right">
          {test.status === "queued" ? "—" : formatDuration(test.durationMs)}
        </span>
      </div>
    </>
  );
  const paddingLeft = indentPaddingLeft(depth);
  return (
    <li className="border-b border-border/60 last:border-b-0">
      {href ? (
        <a
          href={href}
          data-testid="test-row-link"
          className="flex items-center gap-4 pr-5 py-3 hover:bg-muted/30 transition-colors group"
          style={{ paddingLeft }}
        >
          {body}
        </a>
      ) : (
        <div
          className="flex items-center gap-4 pr-5 py-3 opacity-80"
          style={{ paddingLeft }}
        >
          {body}
        </div>
      )}
      {showError && test.errorMessage ? (
        <div
          className="pr-5 pb-4"
          style={{ paddingLeft: `calc(${paddingLeft} + 32px)` }}
        >
          <TestErrorAlert
            errorMessage={test.errorMessage}
            errorStack={test.errorStack}
          >
            {artifactActions && artifactActions.length > 0 ? (
              <ArtifactActions artifacts={artifactActions} />
            ) : null}
          </TestErrorAlert>
        </div>
      ) : null}
    </li>
  );
}

function DescribeHeaderRow({ name, depth }: { name: string; depth: number }) {
  return (
    <li className="border-b border-border/60 last:border-b-0 bg-muted/10">
      <div
        className="flex items-center pr-5 py-2"
        style={{ paddingLeft: indentPaddingLeft(depth) }}
      >
        <span className="font-mono text-[11px] text-muted-foreground truncate">
          {name}
        </span>
      </div>
    </li>
  );
}

type RenderRow =
  | { kind: "describe"; name: string; depth: number; key: string }
  | {
      kind: "test";
      test: RunProgressTest;
      displayTitle: string;
      depth: number;
    };

function flattenDescribeTree(
  nodes: DescribeNode[],
  depth: number,
  pathKey: string,
): RenderRow[] {
  const rows: RenderRow[] = [];
  nodes.forEach((node, i) => {
    if (node.kind === "describe") {
      const key = `${pathKey}/${i}:${node.name}`;
      rows.push({ kind: "describe", name: node.name, depth, key });
      rows.push(...flattenDescribeTree(node.children, depth + 1, key));
    } else {
      rows.push({
        kind: "test",
        test: node.test,
        displayTitle: node.displayTitle,
        depth,
      });
    }
  });
  return rows;
}

function GroupCount({
  status,
  count,
}: {
  status: RunProgressTestStatus;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
      <StatusIcon status={status} />
      {count}
    </span>
  );
}

function FileGroupHeader({ group }: { group: FileGroup }) {
  const hasAnyTerminal =
    group.counts.passed +
      group.counts.failed +
      group.counts.flaky +
      group.counts.skipped +
      group.counts.timedout >
    0;
  return (
    <AccordionHeader className="flex items-center gap-3 px-5 py-3 bg-muted/30 hover:bg-muted/40 transition-colors">
      <AccordionTriggerRaw className="flex flex-1 min-w-0 cursor-pointer items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm data-panel-open:[&>svg.chev]:rotate-180">
        <ChevronDown
          className="chev size-4 shrink-0 text-muted-foreground transition-transform duration-200"
          aria-hidden
        />
        <FileCode size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex items-baseline gap-1.5">
          {group.dir ? (
            <span className="font-mono text-[11px] text-muted-foreground truncate">
              {group.dir}
            </span>
          ) : null}
          <span className="font-mono text-sm text-foreground truncate">
            {group.basename}
          </span>
        </span>
      </AccordionTriggerRaw>
      <div className="flex items-center gap-3 shrink-0">
        <GroupCount status="failed" count={group.counts.failed} />
        <GroupCount status="timedout" count={group.counts.timedout} />
        <GroupCount status="flaky" count={group.counts.flaky} />
        <GroupCount status="passed" count={group.counts.passed} />
        <GroupCount status="skipped" count={group.counts.skipped} />
        <GroupCount status="queued" count={group.counts.queued} />
        {group.projectNames.length > 0 ? (
          <div className="flex items-center gap-1">
            {group.projectNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[10px] text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <span className="font-mono text-xs tabular-nums text-muted-foreground w-14 text-right">
          {hasAnyTerminal ? formatDuration(group.durationMs) : "—"}
        </span>
      </div>
    </AccordionHeader>
  );
}

/**
 * Summary tiles grid (Total / Passed / Failed / Flaky). Pure; safe on the
 * server and inside a client island.
 */
export function RunProgressSummary({ summary }: { summary: RunSummary }) {
  const { counts, expectedTotal } = summary;
  const [filter, setFilter] = useStatusFilter();
  const totalKnown = summary.totalDone + counts.queued;
  const totalValue =
    summary.status === "running" && expectedTotal != null ? (
      <span>
        {summary.totalDone}
        <span className="text-muted-foreground">
          {" / "}
          {expectedTotal}
        </span>
      </span>
    ) : (
      totalKnown
    );
  const toggle = (value: TestStatusFilter) => () => {
    void setFilter(filter === value ? null : value);
  };
  return (
    <div className="grid grid-cols-4 gap-3">
      <SummaryTile
        label="Total"
        value={totalValue}
        isActive={filter === null}
        onClick={() => {
          void setFilter(null);
        }}
      />
      <SummaryTile
        label="Passed"
        value={counts.passed}
        accent
        tone="success"
        isActive={filter === "passed"}
        onClick={toggle("passed")}
      />
      <SummaryTile
        label="Failed"
        value={counts.failed}
        accent
        tone="destructive"
        isActive={filter === "failed"}
        onClick={toggle("failed")}
      />
      <SummaryTile
        label="Flaky"
        value={counts.flaky}
        accent
        tone="warning"
        isActive={filter === "flaky"}
        onClick={toggle("flaky")}
      />
    </div>
  );
}

async function fetchAllPages(
  resultsEndpoint: string,
  startCursor: string | null,
  signal: AbortSignal,
): Promise<RunProgressTest[] | null> {
  const collected: RunProgressTest[] = [];
  let cursor: string | null = startCursor;
  // Always run at least once so the entry case (cursor=null, fetch first
  // page) works for the reconciliation path. The seed path skips this
  // helper entirely when there's no nextCursor.
  while (true) {
    if (signal.aborted) return null;
    const url = new URL(resultsEndpoint, window.location.origin);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { signal }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as {
      results: RunProgressTest[];
      nextCursor: string | null;
    };
    collected.push(...data.results);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return collected;
}

/**
 * Merge an array of test rows into a Map keyed by `RunProgressTest.id`,
 * latest-wins. Returns a new Map (preserves React state-update semantics).
 */
function mergeIntoMap(
  base: Map<string, RunProgressTest>,
  rows: readonly RunProgressTest[],
): Map<string, RunProgressTest> {
  if (rows.length === 0) return base;
  const next = new Map(base);
  for (const r of rows) next.set(r.id, r);
  return next;
}

function buildMap(
  rows: readonly RunProgressTest[],
): Map<string, RunProgressTest> {
  const m = new Map<string, RunProgressTest>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

/**
 * Test list card. Groups tests by their `file` (Cypress-style) and renders
 * each group as a collapsible section with per-file counts, duration, and
 * Playwright project tags. All groups open by default. Pure; safe on the
 * server and inside a client island.
 */
export function RunProgressTests({
  tests,
  totalTests,
  runBase,
  expandErrors = true,
  artifactActionsByTestId,
}: {
  tests: RunProgressTest[];
  /**
   * Run-level test count (`runs.totalTests`). May exceed `tests.length`
   * during paginated load — used in the header so the user sees the
   * authoritative count regardless of progress.
   */
  totalTests: number;
  runBase: string;
  expandErrors?: boolean;
  artifactActionsByTestId?: Record<string, ArtifactAction[]>;
}) {
  const [filter, setFilter] = useStatusFilter();
  const filteredTests = useMemo(
    () => tests.filter((t) => matchesFilter(t.status, filter)),
    [tests, filter],
  );
  const groups = useMemo(() => {
    const sorted = [...filteredTests].sort(
      (a, b) =>
        (RESULT_STATUS_ORDER[a.status] ?? 6) -
        (RESULT_STATUS_ORDER[b.status] ?? 6),
    );
    return groupTestsByFile(sorted);
  }, [filteredTests]);
  const headerTotal = Math.max(totalTests, tests.length);
  const visibleTests = filteredTests.length;
  const defaultOpen = useMemo(() => groups.map((g) => g.file), [groups]);
  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 bg-muted/30">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">Test Results</h3>
          {filter !== null ? (
            <button
              type="button"
              onClick={() => {
                void setFilter(null);
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-border bg-background hover:bg-muted/40 font-mono text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <span className="uppercase tracking-wider">{filter}</span>
              <X size={10} strokeWidth={3} />
            </button>
          ) : null}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {filter === null ? (
            <>
              {headerTotal} {headerTotal === 1 ? "test" : "tests"}
              {groups.length > 0
                ? ` · ${groups.length} ${groups.length === 1 ? "file" : "files"}`
                : ""}
            </>
          ) : (
            <>
              {visibleTests} of {headerTotal}
              {groups.length > 0
                ? ` · ${groups.length} ${groups.length === 1 ? "file" : "files"}`
                : ""}
            </>
          )}
        </span>
      </div>
      {headerTotal === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          No test results recorded for this run.
        </div>
      ) : visibleTests === 0 && filter !== null ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          {FILTER_EMPTY_LABEL[filter]}
        </div>
      ) : (
        <Accordion defaultValue={defaultOpen} multiple>
          {groups.map((group) => {
            const tree = buildDescribeTree(group.tests, group.file);
            const rows = flattenDescribeTree(tree, 0, group.file);
            return (
              <AccordionItem
                key={group.file}
                value={group.file}
                className="border-b border-border/60 last:border-b-0"
              >
                <FileGroupHeader group={group} />
                <AccordionPanel className="pt-0 pb-0">
                  <ul>
                    {rows.map((row) =>
                      row.kind === "describe" ? (
                        <DescribeHeaderRow
                          key={row.key}
                          name={row.name}
                          depth={row.depth}
                        />
                      ) : (
                        <TestRow
                          key={row.test.id}
                          test={row.test}
                          displayTitle={row.displayTitle}
                          depth={row.depth}
                          href={
                            row.test.status === "queued"
                              ? null
                              : `${runBase}/tests/${row.test.id}`
                          }
                          expandError={expandErrors}
                          artifactActions={
                            artifactActionsByTestId?.[row.test.id]
                          }
                        />
                      ),
                    )}
                  </ul>
                </AccordionPanel>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}
    </div>
  );
}

/**
 * Summary-tiles island. Subscribes to the realtime `"summary"` key only,
 * so the four counts re-render on every counter update without being
 * coupled to the test-list payload.
 */
export function RunSummaryIsland({
  initial,
  roomId,
}: {
  initial: RunSummary;
  roomId: string;
}) {
  const [summary] = useSyncedState<RunSummary>(initial, "summary", roomId);
  return <RunProgressSummary summary={summary} />;
}

const PILL_STATUS_DOT: Record<string, string> = {
  passed: "bg-success shadow-[0_0_6px_var(--color-success)]",
  failed: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  timedout: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  flaky: "bg-warning",
  interrupted: "bg-warning",
  skipped: "bg-muted-foreground/30",
  running: "bg-primary animate-pulse shadow-[0_0_6px_var(--color-primary)]",
};

const PILL_STATUS_LABEL: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  timedout: "Timed out",
  flaky: "Flaky",
  interrupted: "Interrupted",
  skipped: "Skipped",
  running: "Running",
};

/**
 * Run-status pill that subscribes to the realtime `"summary"` key so the
 * header dot+label flip from "Running" to the terminal status as soon as
 * `completeRunHandler` broadcasts. Without this, the pill is frozen at
 * the SSR-time value and only refreshes on a full page reload.
 *
 * Mounted only for runs that are `running` at SSR time — terminal runs
 * keep the cheaper static pill in the page so we don't open a WebSocket
 * for a payload that will never change.
 */
export function RunStatusPillIsland({
  initial,
  roomId,
}: {
  initial: RunSummary;
  roomId: string;
}) {
  const [summary] = useSyncedState<RunSummary>(initial, "summary", roomId);
  const status = summary.status;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono text-[11px] uppercase tracking-wider border border-border/50">
      <span
        className={cn(
          "inline-block w-2 h-2 rounded-full",
          PILL_STATUS_DOT[status] ?? "bg-muted-foreground/30",
        )}
      />
      {PILL_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * Test-list island. Maintains a single `Map<testResultId, RunProgressTest>`
 * accumulator as the source of truth for what's displayed:
 *
 *   - **Mount**: Map seeded from SSR-provided `initialTests` (first
 *     REST page).
 *   - **REST forward-pagination** (one-shot, on mount): pages from
 *     `initialNextCursor` to exhaustion are merged into the Map.
 *   - **Live `"tests-tail"` push**: every batch the server broadcasts
 *     just the rows it changed; client merges those into the Map by
 *     id. Persisted across subsequent setStates because the Map is
 *     local React state, not the synced-state value (which gets
 *     replaced on every push).
 *   - **Running→terminal reconcile**: when `summary.status` flips out
 *     of `"running"`, the Map is *replaced* (not merged) from a fresh
 *     full REST refetch — canonical tenant-DB state.
 *
 *   Subscribed keys:
 *   - `"tests-tail"` — per-batch row events.
 *   - `"summary"` — for the authoritative `totalTests` shown in the
 *     list header and to detect the running→terminal transition.
 */
export function RunTestsIsland({
  initialSummary,
  initialTests,
  initialNextCursor,
  roomId,
  runBase,
  resultsEndpoint,
  artifactActionsByTestId,
}: {
  initialSummary: RunSummary;
  initialTests: RunProgressTest[];
  initialNextCursor: string | null;
  roomId: string;
  runBase: string;
  resultsEndpoint: string;
  artifactActionsByTestId?: Record<string, ArtifactAction[]>;
}) {
  const [accumulator, setAccumulator] = useState<Map<string, RunProgressTest>>(
    () => buildMap(initialTests),
  );

  const [tail] = useSyncedState<RunTestsTail>(
    { tests: [], updatedAt: 0 },
    "tests-tail",
    roomId,
  );
  const [summary] = useSyncedState<RunSummary>(
    initialSummary,
    "summary",
    roomId,
  );

  // Each tail push carries only the rows changed in the most recent
  // batch. Merge them into the accumulator (latest-wins). The tail
  // state itself is replaced on every setState, so we cannot rely on
  // it for history — the Map is what holds the run-long picture.
  useEffect(() => {
    if (tail.tests.length === 0) return;
    setAccumulator((prev) => mergeIntoMap(prev, tail.tests));
  }, [tail]);

  // Page forward through any rows beyond the SSR seed (only when the
  // initial seed didn't return everything). One-shot per mount.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!initialNextCursor) return;
    const fetchKey = `${resultsEndpoint}|${initialNextCursor}`;
    if (seededFor.current === fetchKey) return;
    seededFor.current = fetchKey;

    const controller = new AbortController();
    void (async () => {
      const more = await fetchAllPages(
        resultsEndpoint,
        initialNextCursor,
        controller.signal,
      );
      if (!more || controller.signal.aborted) return;
      setAccumulator((prev) => mergeIntoMap(prev, more));
    })();
    return () => controller.abort();
  }, [initialNextCursor, resultsEndpoint]);

  // Running→terminal reconcile: full refetch from canonical tenant DB,
  // *replacing* the accumulator. Fires once on the actual transition.
  const wasRunningRef = useRef(initialSummary.status === "running");
  const [reconcileTrigger, setReconcileTrigger] = useState(0);
  useEffect(() => {
    if (wasRunningRef.current && summary.status !== "running") {
      setReconcileTrigger((t) => t + 1);
    }
    wasRunningRef.current = summary.status === "running";
  }, [summary.status]);

  useEffect(() => {
    if (reconcileTrigger === 0) return;
    const controller = new AbortController();
    void (async () => {
      const all = await fetchAllPages(resultsEndpoint, null, controller.signal);
      if (!all || controller.signal.aborted) return;
      setAccumulator(buildMap(all));
    })();
    return () => controller.abort();
  }, [reconcileTrigger, resultsEndpoint]);

  const tests = useMemo(() => Array.from(accumulator.values()), [accumulator]);

  return (
    <RunProgressTests
      tests={tests}
      totalTests={summary.totalTests}
      runBase={runBase}
      artifactActionsByTestId={artifactActionsByTestId}
    />
  );
}

/**
 * Live status dot for the runs-list table row. Mounted only for rows
 * whose run is `running` at SSR time so the dot flips to the terminal
 * color (and loses the pulse animation) as soon as the summary push
 * lands. Static for terminal rows — they're frozen so a WebSocket
 * subscription would be wasted.
 */
export function RunRowStatusDotIsland({
  initial,
  roomId,
  className,
}: {
  initial: RunSummary;
  roomId: string;
  className?: string;
}) {
  const [summary] = useSyncedState<RunSummary>(initial, "summary", roomId);
  return (
    <span
      className={cn(
        "inline-block rounded-full",
        PILL_STATUS_DOT[summary.status] ?? "bg-muted-foreground/30",
        className,
      )}
    />
  );
}

export interface RunRowProgressIslandProps {
  initial: RunSummary;
  roomId: string;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  runHref: string;
}

/**
 * Live-updating version of the runs list "Tests" cell. Mounts only for rows
 * whose run is currently `running`; the rest of the row stays SSR. Shows a
 * `done/expected` progress pill alongside the four per-status popovers so
 * the list view tracks the same stream the detail page does.
 */
export function RunRowProgressIsland({
  initial,
  roomId,
  teamSlug,
  projectSlug,
  runId,
  runHref,
}: RunRowProgressIslandProps) {
  const [summary] = useSyncedState<RunSummary>(initial, "summary", roomId);
  const showProgressPill =
    summary.status === "running" && summary.expectedTotal != null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {showProgressPill ? (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-primary/40 bg-primary/10 font-mono text-[11px] tabular-nums text-primary">
          {summary.totalDone}/{summary.expectedTotal}
        </span>
      ) : null}
      <RunTestsPopover
        variant="passed"
        count={summary.counts.passed}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
      <RunTestsPopover
        variant="failed"
        count={summary.counts.failed}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
      <RunTestsPopover
        variant="flaky"
        count={summary.counts.flaky}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
      <RunTestsPopover
        variant="skipped"
        count={summary.counts.skipped}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
    </div>
  );
}
