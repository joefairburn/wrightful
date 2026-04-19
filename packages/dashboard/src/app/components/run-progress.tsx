"use client";

import { useSyncedState } from "rwsdk/use-synced-state/client";
import {
  Check,
  CircleSlash,
  Minus,
  TriangleAlert,
  X,
  Circle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import { RunTestsPopover } from "@/app/components/run-tests-popover";
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
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
  tone?: "success" | "destructive" | "warning";
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
    <div
      className={cn(
        "rounded-md bg-background px-3 py-2.5 border border-border/60",
        accent && `border-t-2 ${border}`,
      )}
    >
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </div>
      <div className={cn("font-mono text-xl tabular-nums", text)}>{value}</div>
    </div>
  );
}

function TestRow({
  test,
  href,
  expandError,
}: {
  test: RunProgressTest;
  href: string | null;
  expandError: boolean;
}) {
  const isFailure = test.status === "failed" || test.status === "timedout";
  const showError = isFailure && test.errorMessage && expandError;
  const body = (
    <>
      <StatusIcon status={test.status} />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground truncate">
          {test.file}
        </span>
        <span className="text-muted-foreground/50 shrink-0">›</span>
        <span
          className={cn(
            "text-sm truncate",
            test.status === "queued"
              ? "text-muted-foreground"
              : "text-foreground",
          )}
        >
          {test.title}
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
  return (
    <li className="border-b border-border/60 last:border-b-0">
      {href ? (
        <a
          href={href}
          className="flex items-center gap-4 px-5 py-3 hover:bg-muted/30 transition-colors group"
        >
          {body}
        </a>
      ) : (
        <div className="flex items-center gap-4 px-5 py-3 opacity-80">
          {body}
        </div>
      )}
      {showError ? (
        <div className="px-5 pb-4 pl-[52px]">
          <div className="rounded-md border border-destructive/20 bg-background overflow-hidden">
            <div className="px-3 py-2 border-b border-border/50 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-destructive">
                Error
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {test.status === "timedout" ? "Timed out" : "Failed"}
              </span>
            </div>
            <pre className="px-3 py-2.5 font-mono text-[11px] leading-relaxed text-destructive-foreground whitespace-pre-wrap max-h-64 overflow-auto">
              {test.errorMessage}
            </pre>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Summary tiles grid (Total / Passed / Failed / Flaky). Pure; safe on the
 * server and inside a client island.
 */
export function RunProgressSummary({ progress }: { progress: RunProgress }) {
  const { counts, expectedTotal } = progress;
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
  return (
    <div className="grid grid-cols-4 gap-3">
      <SummaryTile label="Total" value={totalValue} />
      <SummaryTile label="Passed" value={counts.passed} accent tone="success" />
      <SummaryTile
        label="Failed"
        value={counts.failed}
        accent
        tone="destructive"
      />
      <SummaryTile label="Flaky" value={counts.flaky} accent tone="warning" />
    </div>
  );
}

/**
 * Test list card. Queued tests are rendered at the bottom with a neutral
 * circle icon; terminal statuses sort above them and link to the test
 * detail page. Pure; safe on the server and inside a client island.
 */
export function RunProgressTests({
  progress,
  runBase,
  expandErrors = true,
}: {
  progress: RunProgress;
  runBase: string;
  expandErrors?: boolean;
}) {
  const sorted = [...progress.tests].sort(
    (a, b) =>
      (RESULT_STATUS_ORDER[a.status] ?? 6) -
      (RESULT_STATUS_ORDER[b.status] ?? 6),
  );
  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-muted/30">
        <h3 className="text-sm font-semibold tracking-tight">Test Results</h3>
        <span className="font-mono text-[11px] text-muted-foreground">
          {sorted.length} {sorted.length === 1 ? "test" : "tests"}
        </span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          No test results recorded for this run.
        </div>
      ) : (
        <ul>
          {sorted.map((test) => (
            <TestRow
              key={test.id}
              test={test}
              href={
                test.status === "queued" ? null : `${runBase}/tests/${test.id}`
              }
              expandError={expandErrors}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Summary-tiles island. Subscribes to the realtime progress channel via
 * `useSyncedState` and re-renders the four counts on every `setState` push.
 * Seeded with SSR-provided `initial` so the first render matches D1 without
 * waiting on the WebSocket.
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
}: {
  initial: RunProgress;
  roomId: string;
  runBase: string;
}) {
  const [progress] = useSyncedState<RunProgress>(initial, "progress", roomId);
  return <RunProgressTests progress={progress} runBase={runBase} />;
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
