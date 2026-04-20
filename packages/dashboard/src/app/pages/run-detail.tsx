import { and, eq } from "drizzle-orm";
import { ArrowLeft, GitCommit, GitPullRequest } from "lucide-react";
import type React from "react";
import { requestInfo } from "rwsdk/worker";
import {
  RunProgressSummary,
  RunProgressTests,
  RunSummaryIsland,
  RunTestsIsland,
} from "@/app/components/run-progress";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { committedRuns } from "@/db/schema";
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

  const db = getDb();

  const [run] = await db
    .select()
    .from(committedRuns)
    .where(
      and(eq(committedRuns.id, runId), eq(committedRuns.projectId, project.id)),
    )
    .limit(1);

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (!run) {
    return <NotFoundPage />;
  }

  const progress = await composeRunProgress(runId);
  if (!progress) return <NotFoundPage />;

  const origin = new URL(requestInfo.request.url).origin;
  const artifactActionsByTestId = await loadFailingArtifactActions(
    progress.tests.map((t) => ({
      id: t.id,
      status: t.status,
      retryCount: t.retryCount,
    })),
    origin,
  );

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
