import { and, eq } from "drizzle-orm";
import {
  ArrowLeft,
  Check,
  CircleSlash,
  GitCommit,
  GitPullRequest,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import type React from "react";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { committedRuns, testResults } from "@/db/schema";
import { getActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/cn";
import { prUrl } from "@/lib/pr-url";
import { param } from "@/lib/route-params";
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

const RESULT_STATUS_ORDER: Record<string, number> = {
  failed: 0,
  timedout: 1,
  flaky: 2,
  passed: 3,
  skipped: 4,
};

function StatusIcon({ status }: { status: string }) {
  const size = 14;
  const stroke = 3;
  if (status === "passed") {
    return <Check size={size} strokeWidth={stroke} className="text-success" />;
  }
  if (status === "failed" || status === "timedout") {
    return <X size={size} strokeWidth={stroke} className="text-destructive" />;
  }
  if (status === "flaky" || status === "interrupted") {
    return (
      <TriangleAlert size={size} strokeWidth={2.5} className="text-warning" />
    );
  }
  if (status === "skipped") {
    return (
      <Minus size={size} strokeWidth={2.5} className="text-muted-foreground" />
    );
  }
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

  const results = await db
    .select()
    .from(testResults)
    .where(eq(testResults.runId, runId));

  results.sort(
    (a, b) =>
      (RESULT_STATUS_ORDER[a.status] ?? 5) -
      (RESULT_STATUS_ORDER[b.status] ?? 5),
  );

  const shortId = run.id.slice(-7);
  const statusLabel = STATUS_LABEL[run.status] ?? run.status;
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);

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

            <div className="grid grid-cols-4 gap-3">
              <SummaryTile
                label="Total"
                value={
                  run.status === "running" && run.expectedTotalTests != null ? (
                    <span>
                      {run.totalTests}
                      <span className="text-muted-foreground">
                        {" / "}
                        {run.expectedTotalTests}
                      </span>
                    </span>
                  ) : (
                    run.totalTests
                  )
                }
              />
              <SummaryTile
                label="Passed"
                value={run.passed}
                accent
                tone="success"
              />
              <SummaryTile
                label="Failed"
                value={run.failed}
                accent
                tone="destructive"
              />
              <SummaryTile
                label="Flaky"
                value={run.flaky}
                accent
                tone="warning"
              />
            </div>
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
          <div className="rounded-lg bg-card border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-muted/30">
              <h3 className="text-sm font-semibold tracking-tight">
                Test Results
              </h3>
              <span className="font-mono text-[11px] text-muted-foreground">
                {results.length} {results.length === 1 ? "test" : "tests"}
              </span>
            </div>

            {results.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                No test results recorded for this run.
              </div>
            ) : (
              <ul>
                {results.map((result) => {
                  const detailHref = `${base}/runs/${runId}/tests/${result.id}`;
                  const isFailure =
                    result.status === "failed" || result.status === "timedout";
                  const showError = isFailure && result.errorMessage;
                  return (
                    <li
                      key={result.id}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <a
                        href={detailHref}
                        className="flex items-center gap-4 px-5 py-3 hover:bg-muted/30 transition-colors group"
                      >
                        <StatusIcon status={result.status} />
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground truncate">
                            {result.file}
                          </span>
                          <span className="text-muted-foreground/50 shrink-0">
                            ›
                          </span>
                          <span className="text-sm text-foreground truncate group-hover:text-foreground">
                            {result.title}
                          </span>
                          {result.retryCount > 0 && (
                            <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-sm border border-warning/30 bg-warning/10 text-warning font-mono text-[10px]">
                              Retry {result.retryCount}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          {result.projectName && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-background font-mono text-[10px] text-muted-foreground">
                              {result.projectName}
                            </span>
                          )}
                          <span className="font-mono text-xs tabular-nums text-muted-foreground w-14 text-right">
                            {formatDuration(result.durationMs)}
                          </span>
                        </div>
                      </a>
                      {showError && (
                        <div className="px-5 pb-4 pl-[52px]">
                          <div className="rounded-md border border-destructive/20 bg-background overflow-hidden">
                            <div className="px-3 py-2 border-b border-border/50 flex items-center justify-between">
                              <span className="font-mono text-[10px] uppercase tracking-wider text-destructive">
                                Error
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {result.status === "timedout"
                                  ? "Timed out"
                                  : "Failed"}
                              </span>
                            </div>
                            <pre className="px-3 py-2.5 font-mono text-[11px] leading-relaxed text-destructive-foreground whitespace-pre-wrap max-h-64 overflow-auto">
                              {result.errorMessage}
                            </pre>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
