import { Suspense } from "react";
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
import { Skeleton } from "@/app/components/ui/skeleton";
import { NotFoundPage } from "@/app/pages/not-found";
import { type ActiveProject, getActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/cn";
import { prUrl } from "@/lib/pr-url";
import { param } from "@/lib/route-params";
import {
  buildRunSummary,
  type RunProgressTest,
  type RunSummary,
  runRoomId,
  TESTS_TAIL_SIZE,
} from "@/routes/api/progress";
import {
  loadRunResultsPage,
  type RunResultsResponse,
} from "@/routes/api/run-results";
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

interface HistoryRow {
  id: string;
  status: string;
  durationMs: number;
  createdAt: number;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
}

type RunRow = Awaited<ReturnType<typeof loadRun>>;
type ArtifactActionsByTestId = Awaited<
  ReturnType<typeof loadFailingArtifactActions>
>;

function EnvRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}

export async function RunDetailPage(): Promise<React.ReactElement> {
  // Membership + run-existence gates have to resolve before we start
  // streaming the shell: a missing project or runId must surface as a clean
  // 404, and once the document headers have been flushed
  // `requestInfo.response.status` is frozen. The heavy queries below
  // (history, branches, progress, artifact actions) still stream behind
  // their own Suspense boundaries.
  const runId = param("id");

  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const run = await loadRun(project, runId);
  if (!run) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const branchParam = url.searchParams.get("branch");
  const defaultBranch = run.branch ?? ALL_BRANCHES;
  const effectiveBranch = branchParam ?? defaultBranch;
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const origin = url.origin;
  const shortId = run.id.slice(-7);
  const statusLabel = STATUS_LABEL[run.status] ?? run.status;
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
  const roomId = runRoomId({
    teamSlug: project.teamSlug,
    projectSlug: project.slug,
    runId,
  });
  const isRunning = run.status === "running";

  // Summary is a pure derivation off the already-loaded run row; no DO
  // hop. The tests-list seed is a real query — first page of the
  // cursor-paginated REST endpoint, the same code path the client uses
  // for back-pagination — so SSR + REST stay byte-for-byte aligned.
  const summary = buildRunSummary(run);
  const testsSeedPromise: Promise<RunResultsResponse> = loadRunResultsPage(
    project,
    runId,
    { cursor: null, limit: 200, status: null },
  ).then((seed) => {
    if (!seed) {
      throw new Error(`loadRunResultsPage returned no entry for ${runId}`);
    }
    return seed;
  });
  const historyPromise = loadRunHistory(project, effectiveBranch);
  const branchesPromise = loadBranches(project);
  const artifactActionsPromise: Promise<ArtifactActionsByTestId> =
    testsSeedPromise.then((seed) =>
      loadFailingArtifactActions(
        project.db,
        seed.results.map((t) => ({
          id: t.id,
          status: t.status,
          retryCount: t.retryCount,
        })),
        origin,
      ),
    );

  return (
    <>
      {/* Page header — fully derived from `run` */}
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
          <Suspense fallback={<RunHistoryChartFallback />}>
            <RunHistorySection
              historyPromise={historyPromise}
              branchesPromise={branchesPromise}
              run={run}
              base={base}
              teamSlug={project.teamSlug}
              projectSlug={project.slug}
              branchParam={branchParam}
              defaultBranch={defaultBranch}
              effectiveBranch={effectiveBranch}
              runId={runId}
            />
          </Suspense>
        </div>

        {/* Bento header */}
        <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Summary card */}
          <div className="lg:col-span-2 rounded-lg bg-card border border-border p-5 flex flex-col gap-5">
            {/* Badges row — sync from run */}
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

            {/* Progress display — summary is derived synchronously from
                the already-loaded run row, so no Suspense boundary
                needed. Live updates flow through the synced-state
                "summary" key when the run is still active. */}
            <RunProgressInSummary
              summary={summary}
              isRunning={isRunning}
              roomId={roomId}
            />
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
          <Suspense fallback={<RunTestsFallback />}>
            <RunTestsSection
              testsSeedPromise={testsSeedPromise}
              artifactActionsPromise={artifactActionsPromise}
              summary={summary}
              isRunning={isRunning}
              roomId={roomId}
              runBase={`${base}/runs/${runId}`}
              resultsEndpoint={`/api${base}/runs/${runId}/results`}
            />
          </Suspense>
        </div>
      </div>
    </>
  );
}

export async function loadRun(project: ActiveProject, runId: string) {
  return await project.db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .where("projectId", "=", project.id)
    .where("committed", "=", 1)
    .limit(1)
    .executeTakeFirst();
}

async function loadRunHistory(
  project: ActiveProject,
  effectiveBranch: string,
): Promise<HistoryRow[]> {
  let q = project.db
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
    q = q.where("branch", "=", effectiveBranch);
  }
  return q.orderBy("createdAt", "desc").limit(30).execute();
}

async function loadBranches(project: ActiveProject): Promise<string[]> {
  const rows = await project.db
    .selectFrom("runs")
    .select("branch as value")
    .distinct()
    .where("projectId", "=", project.id)
    .where("committed", "=", 1)
    .where("branch", "is not", null)
    .execute();
  return rows
    .map((r) => r.value)
    .filter((v): v is string => !!v)
    .sort();
}

async function RunHistorySection({
  historyPromise,
  branchesPromise,
  run,
  base,
  teamSlug,
  projectSlug,
  branchParam,
  defaultBranch,
  effectiveBranch,
  runId,
}: {
  historyPromise: Promise<HistoryRow[]>;
  branchesPromise: Promise<string[]>;
  run: NonNullable<RunRow>;
  base: string;
  teamSlug: string;
  projectSlug: string;
  branchParam: string | null;
  defaultBranch: string;
  effectiveBranch: string;
  runId: string;
}): Promise<React.ReactElement> {
  const [history, branches] = await Promise.all([
    historyPromise,
    branchesPromise,
  ]);
  const chronological = [...history].reverse();
  // Preserve the active branch filter when clicking a historical bar so the
  // reviewer stays in the same view as they scrub through runs. We only
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
            teamSlug,
            projectSlug,
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
  const delta = avg > 0 ? Math.round(((run.durationMs - avg) / avg) * 100) : 0;

  return (
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
            <span style={{ color: "var(--color-success)" }}>✓ {passed}</span>
            <span style={{ color: "var(--color-destructive)" }}>
              × {failed}
            </span>
            <span style={{ color: "var(--color-warning)" }}>
              ⚠ {flakyCount}
            </span>
            <span className="text-muted-foreground/50">│</span>
            <span>avg {formatDuration(Math.round(avg))}</span>
            {currentInHistory && (
              <span
                style={{
                  color:
                    delta < 0
                      ? "var(--color-success)"
                      : delta > 5
                        ? "var(--color-destructive)"
                        : undefined,
                }}
              >
                {delta >= 0 ? "+" : ""}
                {delta}% vs avg
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
  );
}

function RunHistoryChartFallback(): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-4 w-44" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function RunProgressInSummary({
  summary,
  isRunning,
  roomId,
}: {
  summary: RunSummary;
  isRunning: boolean;
  roomId: string;
}): React.ReactElement {
  return isRunning ? (
    <RunSummaryIsland initial={summary} roomId={roomId} />
  ) : (
    <RunProgressSummary summary={summary} />
  );
}

async function RunTestsSection({
  testsSeedPromise,
  artifactActionsPromise,
  summary,
  isRunning,
  roomId,
  runBase,
  resultsEndpoint,
}: {
  testsSeedPromise: Promise<RunResultsResponse>;
  artifactActionsPromise: Promise<ArtifactActionsByTestId>;
  summary: RunSummary;
  isRunning: boolean;
  roomId: string;
  runBase: string;
  resultsEndpoint: string;
}): Promise<React.ReactElement> {
  const [seed, artifactActionsByTestId] = await Promise.all([
    testsSeedPromise,
    artifactActionsPromise,
  ]);
  if (isRunning) {
    // The tests-tail synced-state key carries newest TESTS_TAIL_SIZE rows;
    // seed it from the same SSR result so the island renders identical
    // bytes either side of the WS handshake.
    const initialTail = {
      tests: seed.results.slice(0, TESTS_TAIL_SIZE),
      updatedAt: Date.now(),
    };
    return (
      <RunTestsIsland
        initialTail={initialTail}
        initialSummary={summary}
        initialTests={seed.results}
        initialNextCursor={seed.nextCursor}
        roomId={roomId}
        runBase={runBase}
        resultsEndpoint={resultsEndpoint}
        artifactActionsByTestId={artifactActionsByTestId}
      />
    );
  }
  return (
    <RunProgressTests
      tests={seed.results}
      totalTests={summary.totalTests}
      runBase={runBase}
      artifactActionsByTestId={artifactActionsByTestId}
    />
  );
}

function RunTestsFallback(): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={`skel-${i}`}
          className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
        >
          <Skeleton className="size-2.5 rounded-full" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
