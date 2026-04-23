import { requestInfo } from "rwsdk/worker";
import type { ArtifactAction } from "@/app/components/artifact-actions";
import { ArtifactsRail } from "@/app/components/artifacts-rail";
import {
  AttemptPanel,
  AttemptTabsBar,
  type AttemptTabItem,
} from "@/app/components/attempt-tabs";
import {
  RunHistoryChart,
  type RunHistoryPoint,
} from "@/app/components/run-history-chart";
import { StatusBadge } from "@/app/components/status-badge";
import { Badge } from "@/app/components/ui/badge";
import { TestErrorAlert } from "@/app/components/test-error-alert";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import { signArtifactToken } from "@/lib/artifact-tokens";
import { cn } from "@/lib/cn";
import { parseTitleSegments } from "@/lib/group-tests-by-file";
import { param } from "@/lib/route-params";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

interface Artifact {
  id: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  attempt: number;
  r2Key: string;
}

// Order within an attempt: trace first (most useful for debugging), then
// video, screenshot, everything else. `other` covers error-context etc.
const TYPE_ORDER: Record<string, number> = {
  trace: 0,
  video: 1,
  screenshot: 2,
  other: 3,
};

function attemptLabel(attempt: number, totalAttempts: number): string {
  if (totalAttempts === 1) return "only attempt";
  if (attempt === 0) return "initial";
  if (attempt === totalAttempts - 1) return "final attempt";
  return `retry ${attempt}`;
}

// Narrow the `timedout` row status down to the icon set that the attempt
// tabs understand (pass/fail/skip). Shared across per-attempt rendering.
type AttemptRowStatus = "passed" | "failed" | "skipped";
function normaliseAttemptRowStatus(status: string): AttemptRowStatus {
  if (status === "passed") return "passed";
  if (status === "skipped") return "skipped";
  // "failed" | "timedout" | anything unexpected → failed
  return "failed";
}

// Small colored dot for the overall test status shown in the container
// header, matching the prototype's left-of-title status indicator.
function AttemptsHeaderIcon({
  status,
}: {
  status: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        overallStatusDotColor(status),
      )}
      aria-label={status}
    />
  );
}

function overallStatusDotColor(status: string): string {
  if (status === "passed") return "bg-success";
  if (status === "failed" || status === "timedout") return "bg-destructive";
  if (status === "flaky") return "bg-warning";
  return "bg-muted-foreground/50";
}

function overallStatusTextColor(status: string): string {
  if (status === "passed") return "text-success";
  if (status === "failed" || status === "timedout") return "text-destructive";
  if (status === "flaky") return "text-warning";
  return "text-muted-foreground";
}

function overallStatusLabel(status: string): string {
  if (status === "timedout") return "Timed out";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Build a trace.playwright.dev link wrapping a presigned R2 GET URL.
 *
 * Our own download endpoint 302s to the presigned R2 URL. trace.playwright.dev
 * follows the redirect and loads the underlying .zip.
 *
 * NOTE: this is a link-out for now. A self-hosted trace-viewer component is
 * tracked for Phase 5 so teams running Wrightful behind a corporate firewall
 * (where trace.playwright.dev may not be reachable) aren't blocked. */
function traceViewerUrl(
  origin: string,
  artifactId: string,
  token: string,
): string {
  const downloadUrl = `${origin}/api/artifacts/${artifactId}/download?t=${encodeURIComponent(token)}`;
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(downloadUrl)}`;
}

export async function TestDetailPage() {
  const runId = param("runId");
  const testResultId = param("testResultId");
  const origin = new URL(requestInfo.request.url).origin;

  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const tenantDb = project.db;

  // Two queries — one gated on `runs.committed = 1` to prove ownership + hide
  // uncommitted rows, one to surface run-level metadata (playwrightVersion).
  const [result, run] = await Promise.all([
    tenantDb
      .selectFrom("testResults")
      .innerJoin("runs", "runs.id", "testResults.runId")
      .selectAll("testResults")
      .where("testResults.id", "=", testResultId)
      .where("testResults.runId", "=", runId)
      .where("runs.projectId", "=", project.id)
      .where("runs.committed", "=", 1)
      .limit(1)
      .executeTakeFirst(),
    tenantDb
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .where("projectId", "=", project.id)
      .where("committed", "=", 1)
      .limit(1)
      .executeTakeFirst(),
  ]);

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (!result || !run) {
    return (
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <h1 className="mb-2 font-semibold text-2xl">Test not found</h1>
        <a
          href={`${base}/runs/${runId}`}
          className="text-foreground underline-offset-4 hover:underline"
        >
          Back to run
        </a>
      </div>
    );
  }

  const [tagRows, annotationRows, artifactRows, attemptRows, historyRows] =
    await Promise.all([
      tenantDb
        .selectFrom("testTags")
        .select("tag")
        .where("testResultId", "=", testResultId)
        .execute(),
      tenantDb
        .selectFrom("testAnnotations")
        .select(["type", "description"])
        .where("testResultId", "=", testResultId)
        .execute(),
      tenantDb
        .selectFrom("artifacts")
        .select([
          "id",
          "type",
          "name",
          "contentType",
          "sizeBytes",
          "attempt",
          "r2Key",
        ])
        .where("testResultId", "=", testResultId)
        .orderBy("attempt", "asc")
        .execute(),
      tenantDb
        .selectFrom("testResultAttempts")
        .select([
          "attempt",
          "status",
          "durationMs",
          "errorMessage",
          "errorStack",
        ])
        .where("testResultId", "=", testResultId)
        .orderBy("attempt", "asc")
        .execute(),
      // Last 30 occurrences of this same test across runs — groups by
      // `testResults.testId` (a deterministic hash of file + title + project)
      // so the same spec follows a reviewer across branches and retries.
      tenantDb
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .select([
          "testResults.id as testResultId",
          "testResults.runId as runId",
          "testResults.status as status",
          "testResults.durationMs as durationMs",
          "testResults.createdAt as createdAt",
          "runs.branch as branch",
          "runs.commitSha as commitSha",
        ])
        .where("testResults.testId", "=", result.testId)
        .where("runs.projectId", "=", project.id)
        .where("runs.committed", "=", 1)
        .orderBy("testResults.createdAt", "desc")
        .limit(30)
        .execute(),
    ]);

  const artifactsByAttempt = new Map<number, Artifact[]>();
  for (const a of artifactRows) {
    const bucket = artifactsByAttempt.get(a.attempt) ?? [];
    bucket.push(a);
    artifactsByAttempt.set(a.attempt, bucket);
  }
  for (const bucket of artifactsByAttempt.values()) {
    bucket.sort((x, y) => {
      const dx = TYPE_ORDER[x.type] ?? 99;
      const dy = TYPE_ORDER[y.type] ?? 99;
      if (dx !== dy) return dx - dy;
      return x.name.localeCompare(y.name);
    });
  }
  // Prefer the stored per-attempt rows as the source of truth. Fall back to
  // artifact-implied attempts + `retryCount + 1` for rows ingested before
  // the `test_result_attempts` table existed (no production data pre-launch,
  // but this keeps dev DBs readable through the transition).
  const maxObservedAttempt =
    artifactRows.length > 0
      ? Math.max(...artifactRows.map((a) => a.attempt))
      : -1;
  const totalAttempts =
    attemptRows.length > 0
      ? attemptRows.length
      : Math.max(result.retryCount + 1, maxObservedAttempt + 1);

  const attemptsByIndex = new Map<
    number,
    {
      status: string;
      errorMessage: string | null;
      errorStack: string | null;
    }
  >();
  for (const row of attemptRows) {
    attemptsByIndex.set(row.attempt, {
      status: row.status,
      errorMessage: row.errorMessage,
      errorStack: row.errorStack,
    });
  }

  const artifactTokens = new Map<string, string>();
  await Promise.all(
    artifactRows.map(async (a) => {
      artifactTokens.set(
        a.id,
        await signArtifactToken({
          r2Key: a.r2Key,
          contentType: a.contentType,
        }),
      );
    }),
  );
  const downloadHref = (artifactId: string): string =>
    `/api/artifacts/${artifactId}/download?t=${encodeURIComponent(artifactTokens.get(artifactId) ?? "")}`;

  const allAttempts = Array.from({ length: totalAttempts }, (_, i) => i);
  // Fallback for rows ingested before the test_result_attempts table existed:
  // attach the aggregate error to the last attempt (failed/timedout) or the
  // first (flaky). Once every row has stored attempt data, this is unused.
  const fallbackErrorOn: number | null =
    attemptRows.length === 0
      ? result.status === "failed" || result.status === "timedout"
        ? totalAttempts - 1
        : result.status === "flaky"
          ? 0
          : null
      : null;
  const toAction = (a: Artifact): ArtifactAction => ({
    id: a.id,
    type: a.type,
    name: a.name,
    contentType: a.contentType,
    downloadHref: downloadHref(a.id),
    traceViewerUrl:
      a.type === "trace"
        ? traceViewerUrl(origin, a.id, artifactTokens.get(a.id) ?? "")
        : undefined,
  });
  // Default to the final attempt — the terminal state users most often want.
  const defaultTab = String(totalAttempts - 1);

  const { testTitle } = parseTitleSegments(
    result.title,
    result.file,
    result.projectName,
  );
  const reproduceCommand = `npx playwright test ${JSON.stringify(
    result.file,
  )} --grep ${JSON.stringify(testTitle)}`;

  const chronologicalHistory = [...historyRows].reverse();
  const historyPoints: RunHistoryPoint[] = chronologicalHistory.map((h) => ({
    id: h.testResultId,
    durationMs: h.durationMs,
    status: h.status,
    current: h.testResultId === testResultId,
    href:
      h.testResultId === testResultId
        ? undefined
        : `${base}/runs/${h.runId}/tests/${h.testResultId}`,
    hover:
      h.testResultId === testResultId
        ? undefined
        : {
            kind: "testResult" as const,
            teamSlug: project.teamSlug,
            projectSlug: project.slug,
            runId: h.runId,
            testResultId: h.testResultId,
          },
    label: [
      h.status,
      formatDuration(h.durationMs),
      formatRelativeTime(h.createdAt),
      h.branch,
      h.commitSha ? h.commitSha.slice(0, 7) : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  const historyStats = (() => {
    const ran = chronologicalHistory.filter(
      (h) => h.status !== "skipped",
    ).length;
    const failed = chronologicalHistory.filter(
      (h) => h.status === "failed" || h.status === "timedout",
    ).length;
    const flakyCount = chronologicalHistory.filter(
      (h) => h.status === "flaky",
    ).length;
    const passPct =
      ran === 0 ? 100 : Math.round(((ran - failed - flakyCount) / ran) * 100);
    return { ran, failed, flakyCount, passPct };
  })();

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <a
            href={`${base}/runs/${runId}`}
            className="hover:text-foreground transition-colors"
          >
            &larr; Back to run
          </a>
        </div>
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <StatusBadge status={result.status} />
          <h1 className="font-semibold text-xl">{testTitle}</h1>
        </div>
        <div className="font-mono text-muted-foreground text-xs">
          {result.file}
          {result.projectName ? ` · ${result.projectName}` : ""} ·{" "}
          {formatDuration(result.durationMs)}
          {result.retryCount > 0 ? ` · ${result.retryCount} retries` : ""}
        </div>
        {(tagRows.length > 0 || annotationRows.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {tagRows.map((t, i) => (
              <Badge key={`tag-${i}`} variant="info" size="sm">
                {t.tag}
              </Badge>
            ))}
            {annotationRows.map((a, i) => (
              <Badge
                key={`ann-${i}`}
                variant="warning"
                size="sm"
                title={a.description ?? undefined}
              >
                {a.type}
                {a.description ? `: ${a.description}` : ""}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="px-6 pt-4 pb-2 shrink-0">
        <RunHistoryChart
          points={historyPoints}
          title={`Duration · last ${historyPoints.length} run${historyPoints.length === 1 ? "" : "s"} of this test`}
          subtitle={result.file}
          rightSlot={
            historyPoints.length > 1 ? (
              <>
                <span>pass {historyStats.passPct}%</span>
                <span style={{ color: "var(--color-destructive)" }}>
                  × {historyStats.failed}
                </span>
                <span style={{ color: "var(--color-warning)" }}>
                  ⚠ {historyStats.flakyCount}
                </span>
              </>
            ) : null
          }
          emptyState="No prior runs recorded for this test yet."
        />
      </div>

      {(() => {
        const tabValues = allAttempts.map((a) => String(a));
        // Resolve each attempt's status + error: prefer the stored
        // test_result_attempts row, fall back to the aggregate for older
        // data (see `fallbackErrorOn`).
        const resolveAttemptView = (attempt: number) => {
          const row = attemptsByIndex.get(attempt);
          if (row) {
            return {
              status: normaliseAttemptRowStatus(row.status),
              errorMessage: row.errorMessage,
              errorStack: row.errorStack,
            };
          }
          // Legacy fallback path.
          const finalStatus = result.status;
          const inferred: AttemptRowStatus =
            finalStatus === "skipped"
              ? "skipped"
              : finalStatus === "passed"
                ? "passed"
                : finalStatus === "flaky"
                  ? attempt === totalAttempts - 1
                    ? "passed"
                    : "failed"
                  : "failed";
          const isErrorOn = fallbackErrorOn === attempt;
          return {
            status: inferred,
            errorMessage: isErrorOn ? result.errorMessage : null,
            errorStack: isErrorOn ? result.errorStack : null,
          };
        };
        const tabItems: AttemptTabItem[] = allAttempts.map((attempt) => ({
          value: String(attempt),
          status: resolveAttemptView(attempt).status,
          label: `Attempt ${attempt + 1}`,
          finalSuffix:
            attempt === totalAttempts - 1 && totalAttempts > 1
              ? "(Final)"
              : null,
        }));
        return (
          <div className="flex-1 min-h-0 flex flex-row gap-0">
            <section className="flex-[3] min-w-0 flex flex-col border-r border-border bg-background">
              <header className="shrink-0 bg-muted/20">
                <div className="flex items-center justify-between px-5 h-12 border-b border-border">
                  <div className="flex items-center gap-2 min-w-0">
                    <AttemptsHeaderIcon status={result.status} />
                    <h2 className="text-sm font-semibold tracking-tight">
                      Attempts & errors
                    </h2>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground shrink-0">
                    {totalAttempts > 1 ? (
                      <>
                        <span>{totalAttempts} attempts</span>
                        <span className="inline-block w-1 h-1 rounded-full bg-muted-foreground/50" />
                      </>
                    ) : null}
                    <span
                      className={cn(
                        "uppercase tracking-wider",
                        overallStatusTextColor(result.status),
                      )}
                    >
                      {overallStatusLabel(result.status)}
                    </span>
                  </div>
                </div>
                {totalAttempts > 1 ? (
                  <div className="px-3 pt-2 border-b border-border">
                    <AttemptTabsBar
                      items={tabItems}
                      defaultValue={defaultTab}
                    />
                  </div>
                ) : null}
              </header>
              <div className="flex-1 min-h-0 overflow-auto">
                {allAttempts.map((attempt) => {
                  const view = resolveAttemptView(attempt);
                  return (
                    <AttemptPanel
                      key={attempt}
                      value={String(attempt)}
                      values={tabValues}
                      defaultValue={defaultTab}
                      className="p-5"
                    >
                      {view.errorMessage ? (
                        <TestErrorAlert
                          errorMessage={view.errorMessage}
                          errorStack={view.errorStack}
                        />
                      ) : (
                        <p className="text-muted-foreground text-sm">
                          {attemptLabel(attempt, totalAttempts) ===
                          "only attempt"
                            ? "No error details recorded."
                            : `No error details recorded for this attempt (${attemptLabel(attempt, totalAttempts)}).`}
                        </p>
                      )}
                    </AttemptPanel>
                  );
                })}
              </div>
            </section>
            <aside className="w-[320px] shrink-0 overflow-y-auto bg-muted/10">
              {allAttempts.map((attempt) => {
                const group = artifactsByAttempt.get(attempt) ?? [];
                const copyPromptRaw = group.find((a) => a.type === "other");
                const mediaActions: ArtifactAction[] = group
                  .filter((a) => a.type !== "other")
                  .map(toAction);
                return (
                  <AttemptPanel
                    key={attempt}
                    value={String(attempt)}
                    values={tabValues}
                    defaultValue={defaultTab}
                  >
                    <ArtifactsRail
                      media={mediaActions}
                      copyPrompt={
                        copyPromptRaw ? toAction(copyPromptRaw) : null
                      }
                      reproduceCommand={reproduceCommand}
                      environment={{
                        browser: result.projectName,
                        workerIndex: result.workerIndex,
                        playwrightVersion: run.playwrightVersion,
                      }}
                    />
                  </AttemptPanel>
                );
              })}
            </aside>
          </div>
        );
      })()}
    </div>
  );
}
