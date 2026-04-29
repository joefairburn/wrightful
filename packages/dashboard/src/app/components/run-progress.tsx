"use client";

import { useMemo } from "react";
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
  RunProgress,
  RunProgressTest,
  RunProgressTestStatus,
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
export function RunProgressSummary({ progress }: { progress: RunProgress }) {
  const { counts, expectedTotal } = progress;
  const [filter, setFilter] = useStatusFilter();
  const totalKnown = progress.totalDone + counts.queued;
  const totalValue =
    progress.status === "running" && expectedTotal != null ? (
      <span>
        {progress.totalDone}
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

/**
 * Test list card. Groups tests by their `file` (Cypress-style) and renders
 * each group as a collapsible section with per-file counts, duration, and
 * Playwright project tags. All groups open by default. Pure; safe on the
 * server and inside a client island.
 */
export function RunProgressTests({
  progress,
  runBase,
  expandErrors = true,
  artifactActionsByTestId,
}: {
  progress: RunProgress;
  runBase: string;
  expandErrors?: boolean;
  artifactActionsByTestId?: Record<string, ArtifactAction[]>;
}) {
  const [filter, setFilter] = useStatusFilter();
  const filteredTests = useMemo(
    () => progress.tests.filter((t) => matchesFilter(t.status, filter)),
    [progress.tests, filter],
  );
  const groups = useMemo(() => {
    const sorted = [...filteredTests].sort(
      (a, b) =>
        (RESULT_STATUS_ORDER[a.status] ?? 6) -
        (RESULT_STATUS_ORDER[b.status] ?? 6),
    );
    return groupTestsByFile(sorted);
  }, [filteredTests]);
  const totalTests = progress.tests.length;
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
              {totalTests} {totalTests === 1 ? "test" : "tests"}
              {groups.length > 0
                ? ` · ${groups.length} ${groups.length === 1 ? "file" : "files"}`
                : ""}
            </>
          ) : (
            <>
              {visibleTests} of {totalTests}
              {groups.length > 0
                ? ` · ${groups.length} ${groups.length === 1 ? "file" : "files"}`
                : ""}
            </>
          )}
        </span>
      </div>
      {totalTests === 0 ? (
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
 * Summary-tiles island. Subscribes to the realtime progress channel via
 * `useSyncedState` and re-renders the four counts on every `setState` push.
 * Seeded with SSR-provided `initial` so the first render matches the
 * server-rendered state without waiting on the WebSocket.
 */
export function RunSummaryIsland({
  initial,
  roomId,
}: {
  initial: RunProgress;
  roomId: string;
}) {
  const [progress] = useSyncedState<RunProgress>(initial, "progress", roomId);
  return <RunProgressSummary progress={progress} />;
}

/**
 * Test-list island. Separate from the summary island so each can live in
 * its natural layout slot (summary inside the bento card, test list
 * full-width below). Both islands subscribe to the same
 * `"progress"` key in the same room → one WebSocket, two hook
 * subscriptions, identical updates delivered to both.
 */
export function RunTestsIsland({
  initial,
  roomId,
  runBase,
  artifactActionsByTestId,
}: {
  initial: RunProgress;
  roomId: string;
  runBase: string;
  artifactActionsByTestId?: Record<string, ArtifactAction[]>;
}) {
  const [progress] = useSyncedState<RunProgress>(initial, "progress", roomId);
  return (
    <RunProgressTests
      progress={progress}
      runBase={runBase}
      artifactActionsByTestId={artifactActionsByTestId}
    />
  );
}

export interface RunRowProgressIslandProps {
  initial: RunProgress;
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
  const [progress] = useSyncedState<RunProgress>(initial, "progress", roomId);
  const showProgressPill =
    progress.status === "running" && progress.expectedTotal != null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {showProgressPill ? (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-primary/40 bg-primary/10 font-mono text-[11px] tabular-nums text-primary">
          {progress.totalDone}/{progress.expectedTotal}
        </span>
      ) : null}
      <RunTestsPopover
        variant="passed"
        count={progress.counts.passed}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
      <RunTestsPopover
        variant="failed"
        count={progress.counts.failed}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
      <RunTestsPopover
        variant="flaky"
        count={progress.counts.flaky}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
      <RunTestsPopover
        variant="skipped"
        count={progress.counts.skipped}
        teamSlug={teamSlug}
        projectSlug={projectSlug}
        runId={runId}
        runHref={runHref}
      />
    </div>
  );
}
