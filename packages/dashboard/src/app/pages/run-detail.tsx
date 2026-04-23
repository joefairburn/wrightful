import { ArrowLeft, GitCommit, GitPullRequest } from "lucide-react";
import type React from "react";
import { requestInfo } from "rwsdk/worker";
import { RunHistoryBranchFilter } from "@/app/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/app/components/run-history-branch-filter.shared";
import {
  RunHistoryChart,
  type RunHistoryPoint,
} from "@/app/components/run-history-chart";
import {
  RunProgressSummary,
  RunProgressTests,
  RunSummaryIsland,
  RunTestsIsland,
} from "@/app/components/run-progress";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/cn";
import { prUrl } from "@/lib/pr-url";
import { param } from "@/lib/route-params";
import { composeRunProgress, runRoomId } from "@/routes/api/progress";
import { loadFailingArtifactActions } from "@/lib/test-artifact-actions";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

const STATUS_DOT: Record<string, string> = {
  passed: "bg-success shadow-[0_0_6px_var(--color-success)]",
  failed: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  timedout: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  flaky: "bg-warning",
  interrupted: "bg-warning",
  skipped: "bg-muted-foreground/30",
  running: "bg-primary animate-pulse shadow-[0_0_6px_var(--color-primary)]",
};

const STATUS_LABEL: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  timedout: "Timed out",
  flaky: "Flaky",
  interrupted: "Interrupted",
  skipped: "Skipped",
  running: "Running",
};

function EnvRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}

export async function RunDetailPage() {
  const runId = param("id");

  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const run = await project.db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .where("projectId", "=", project.id)
    .where("committed", "=", 1)
    .limit(1)
    .executeTakeFirst();

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (!run) {
    return <NotFoundPage />;
  }

  // Last 30 runs, filtered by branch. The effective branch comes from
  // `?branch` (so a reviewer can widen to all branches or jump to another
  // branch's history) and defaults to the current run's branch. `committed = 1`
  // hides the uncommitted rows we filter everywhere else.
  const url = new URL(requestInfo.request.url);
  const branchParam = url.searchParams.get("branch");
  const defaultBranch = run.branch ?? ALL_BRANCHES;
  const effectiveBranch = branchParam ?? defaultBranch;

  let historyQuery = project.db
    .selectFrom("runs")
    .select([
      "id",
      "status",
      "durationMs",
      "createdAt",
      "branch",
      "commitSha",
      "commitMessage",
    ])
    .where("projectId", "=", project.id)
    .where("committed", "=", 1);
  if (effectiveBranch !== ALL_BRANCHES) {
    historyQuery = historyQuery.where("branch", "=", effectiveBranch);
  }

  const [progress, history, branchRows] = await Promise.all([
    composeRunProgress(project, runId),
    historyQuery.orderBy("createdAt", "desc").limit(30).execute(),
    project.db
      .selectFrom("runs")
      .select("branch as value")
      .distinct()
      .where("projectId", "=", project.id)
      .where("committed", "=", 1)
      .where("branch", "is not", null)
      .execute(),
  ]);
  if (!progress) return <NotFoundPage />;

  const branches = branchRows
    .map((r) => r.value)
    .filter((v): v is string => !!v)
    .sort();

  const origin = url.origin;
  const artifactActionsByTestId = await loadFailingArtifactActions(
    project.db,
    progress.tests.map((t) => ({
      id: t.id,
      status: t.status,
      retryCount: t.retryCount,
    })),
    origin,
  );

  const chronological = [...history].reverse();
  // Preserve the active branch filter when clicking a historical bar so the
  // reviewer stays in the same "view" as they scrub through runs. We only
  // append the param when it was explicitly set in the URL — otherwise the
  // default (current run's branch) should resolve fresh on the next page.
  const hrefQuery = branchParam
    ? `?branch=${encodeURIComponent(branchParam)}`
    : "";
  const historyPoints: RunHistoryPoint[] = chronological.map((h) => ({
    id: h.id,
    durationMs: h.durationMs,
    status: h.status,
    current: h.id === runId,
    href: h.id === runId ? undefined : `${base}/runs/${h.id}${hrefQuery}`,
    hover:
      h.id === runId
        ? undefined
        : {
            kind: "run" as const,
            teamSlug: project.teamSlug,
            projectSlug: project.slug,
            runId: h.id,
          },
    label: [
      h.status,
      formatDuration(h.durationMs),
      formatRelativeTime(h.createdAt),
      h.commitSha ? h.commitSha.slice(0, 7) : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  const currentInHistory = historyPoints.some((p) => p.current);
  const historyStats = (() => {
    const prior = chronological.filter((h) => h.id !== runId);
    const priorDurations = prior.map((h) => h.durationMs);
    const avg =
      priorDurations.length > 0
        ? priorDurations.reduce((s, n) => s + n, 0) / priorDurations.length
        : 0;
    const passed = chronological.filter((h) => h.status === "passed").length;
    const failed = chronological.filter(
      (h) => h.status === "failed" || h.status === "timedout",
    ).length;
    const flakyCount = chronological.filter((h) => h.status === "flaky").length;
    const delta =
      avg > 0 ? Math.round(((run.durationMs - avg) / avg) * 100) : 0;
    return { avg, passed, failed, flakyCount, delta };
  })();

  const shortId = run.id.slice(-7);
  const statusLabel = STATUS_LABEL[run.status] ?? run.status;
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
  const roomId = runRoomId({
    teamSlug: project.teamSlug,
    projectSlug: project.slug,
    runId,
  });
  const isRunning = run.status === "running";

  return (
    <>
      {/* Page header */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <a
            href={base}
            className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            All runs
          </a>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-base font-semibold tracking-tight truncate">
              Run #{shortId}
            </h2>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono text-[11px] uppercase tracking-wider border border-border/50">
              <span
                className={cn(
                  "inline-block w-2 h-2 rounded-full",
                  STATUS_DOT[run.status] ?? "bg-muted-foreground/30",
                )}
              />
              {statusLabel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-muted-foreground shrink-0">
          <span>{formatRelativeTime(run.createdAt)}</span>
          <span className="tabular-nums">{formatDuration(run.durationMs)}</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* History chart */}
        <div className="px-6 pt-5">
          <RunHistoryChart
            points={historyPoints}
            title={`Duration · last ${historyPoints.length} run${historyPoints.length === 1 ? "" : "s"}`}
            subtitle={
              <RunHistoryBranchFilter
                branches={branches}
                defaultValue={defaultBranch}
              />
            }
            rightSlot={
              historyPoints.length > 1 ? (
                <>
                  <span style={{ color: "var(--color-success)" }}>
                    ✓ {historyStats.passed}
                  </span>
                  <span style={{ color: "var(--color-destructive)" }}>
                    × {historyStats.failed}
                  </span>
                  <span style={{ color: "var(--color-warning)" }}>
                    ⚠ {historyStats.flakyCount}
                  </span>
                  <span className="text-muted-foreground/50">│</span>
                  <span>
                    avg {formatDuration(Math.round(historyStats.avg))}
                  </span>
                  {currentInHistory && (
                    <span
                      style={{
                        color:
                          historyStats.delta < 0
                            ? "var(--color-success)"
                            : historyStats.delta > 5
                              ? "var(--color-destructive)"
                              : undefined,
                      }}
                    >
                      {historyStats.delta >= 0 ? "+" : ""}
                      {historyStats.delta}% vs avg
                    </span>
                  )}
                </>
              ) : null
            }
            emptyState={
              effectiveBranch === ALL_BRANCHES
                ? "No run history yet."
                : `No run history on ${effectiveBranch} yet.`
            }
          />
        </div>
        {/* Bento header */}
        <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Summary card */}
          <div className="lg:col-span-2 rounded-lg bg-card border border-border p-5 flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                {run.branch ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[11px] text-foreground max-w-[200px] truncate">
                    {run.branch}
                  </span>
                ) : null}
                {run.environment ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-muted/40 font-mono text-[11px] text-foreground max-w-[200px] truncate">
                    {run.environment}
                  </span>
                ) : null}
                {run.prNumber != null ? (
                  prHref ? (
                    <a
                      href={prHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/30"
                      title={`Open PR #${run.prNumber}`}
                    >
                      <GitPullRequest size={12} />#{run.prNumber}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[11px] text-muted-foreground">
                      <GitPullRequest size={12} />#{run.prNumber}
                    </span>
                  )
                ) : null}
                {run.commitSha ? (
                  <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[11px] text-muted-foreground">
                    <GitCommit size={12} />
                    {run.commitSha.slice(0, 7)}
                  </span>
                ) : null}
                {run.actor ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[11px] text-muted-foreground">
                    @{run.actor}
                  </span>
                ) : null}
                {run.commitMessage ? (
                  <span className="text-sm text-foreground truncate max-w-[520px]">
                    {run.commitMessage}
                  </span>
                ) : null}
              </div>
            </div>

            {isRunning ? (
              <RunSummaryIsland initial={progress} roomId={roomId} />
            ) : (
              <RunProgressSummary progress={progress} />
            )}
          </div>

          {/* Build card */}
          <div className="rounded-lg bg-card border border-border p-5">
            <h3 className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-4">
              Build
            </h3>
            <div className="space-y-2.5">
              {run.environment && (
                <EnvRow label="Environment" value={run.environment} />
              )}
              {run.playwrightVersion && (
                <EnvRow label="Playwright" value={run.playwrightVersion} />
              )}
              {run.reporterVersion && (
                <EnvRow label="Reporter" value={run.reporterVersion} />
              )}
              {run.ciProvider && <EnvRow label="CI" value={run.ciProvider} />}
              {run.ciBuildId && <EnvRow label="Build" value={run.ciBuildId} />}
              {run.actor && (
                <EnvRow label="Triggered by" value={`@${run.actor}`} />
              )}
              {run.prNumber != null && (
                <EnvRow
                  label="PR"
                  value={
                    prHref ? (
                      <a
                        href={prHref}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-foreground underline-offset-2 hover:underline"
                      >
                        #{run.prNumber}
                      </a>
                    ) : (
                      `#${run.prNumber}`
                    )
                  }
                />
              )}
              {!run.environment &&
                !run.playwrightVersion &&
                !run.reporterVersion &&
                !run.ciProvider &&
                !run.ciBuildId &&
                !run.actor &&
                run.prNumber == null && (
                  <div className="text-xs text-muted-foreground italic">
                    No build data
                  </div>
                )}
            </div>
          </div>
        </div>

        {/* Test results */}
        <div className="px-6 pb-6">
          {isRunning ? (
            <RunTestsIsland
              initial={progress}
              roomId={roomId}
              runBase={`${base}/runs/${run.id}`}
              artifactActionsByTestId={artifactActionsByTestId}
            />
          ) : (
            <RunProgressTests
              progress={progress}
              runBase={`${base}/runs/${run.id}`}
              artifactActionsByTestId={artifactActionsByTestId}
            />
          )}
        </div>
      </div>
    </>
  );
}
