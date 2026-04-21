import { DurationChart } from "@/app/components/duration-chart";
import { Sparkline } from "@/app/components/sparkline";
import { StatusBadge } from "@/app/components/status-badge";
import { Card, CardPanel } from "@/app/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/cn";
import { param } from "@/lib/route-params";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

const HISTORY_LIMIT = 50;

function flakinessPercent(rows: Array<{ status: string }>): {
  ran: number;
  failed: number;
  flaky: number;
  pct: number;
} {
  const ran = rows.filter((r) => r.status !== "skipped").length;
  const failed = rows.filter(
    (r) => r.status === "failed" || r.status === "timedout",
  ).length;
  const flaky = rows.filter((r) => r.status === "flaky").length;
  const pct = ran === 0 ? 0 : Math.round(((failed + flaky) / ran) * 100);
  return { ran, failed, flaky, pct };
}

function pctColorClass(pct: number): string {
  if (pct >= 20) return "text-destructive-foreground";
  if (pct > 0) return "text-warning-foreground";
  return "text-success-foreground";
}

export async function TestHistoryPage() {
  const testId = param("testId");

  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const tenantDb = project.db;

  // Inner-join runs for branch/commit context on each point, scoped to
  // project. The `runs.committed = 1` predicate keeps in-flight /
  // uncommitted runs out of the history view.
  const history = await tenantDb
    .selectFrom("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .select([
      "testResults.id as testResultId",
      "testResults.runId as runId",
      "testResults.status as status",
      "testResults.title as title",
      "testResults.file as file",
      "testResults.projectName as projectName",
      "testResults.durationMs as durationMs",
      "testResults.createdAt as createdAt",
      "runs.branch as branch",
      "runs.commitSha as commitSha",
    ])
    .where("testResults.testId", "=", testId)
    .where("runs.projectId", "=", project.id)
    .where("runs.committed", "=", 1)
    .orderBy("testResults.createdAt", "desc")
    .limit(HISTORY_LIMIT)
    .execute();

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (history.length === 0) {
    return (
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <h1 className="mb-2 font-semibold text-2xl">
          No history for this test
        </h1>
        <p className="mb-4 text-muted-foreground">
          This test identifier has no recorded runs. If you recently renamed the
          test, file, or project, it will appear as a new test id.
        </p>
        <a
          href={base}
          className="text-foreground underline-offset-4 hover:underline"
        >
          Back to runs
        </a>
      </div>
    );
  }

  const mostRecent = history[0];
  const { ran, failed, flaky, pct } = flakinessPercent(history);

  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-8">
      <div className="mb-2">
        <a
          href={`${base}/runs/${mostRecent.runId}/tests/${mostRecent.testResultId}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; Back to latest run
        </a>
      </div>

      <h1 className="mb-1 font-semibold text-xl">{mostRecent.title}</h1>
      <div className="mb-6 font-mono text-muted-foreground text-sm">
        {mostRecent.file}
        {mostRecent.projectName && ` · ${mostRecent.projectName}`}
      </div>

      <Card className="mb-6">
        <CardPanel className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div>
            <div className="text-muted-foreground text-xs">Last {ran} runs</div>
            <div className={cn("font-semibold text-2xl", pctColorClass(pct))}>
              {pct}%
            </div>
            <div className="text-muted-foreground text-xs">
              {failed} failed · {flaky} flaky
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground text-xs">
              Status timeline (oldest → newest)
            </div>
            <Sparkline
              points={[...history].reverse().map((h) => ({
                status: h.status,
                label: `${h.status} — ${formatDuration(h.durationMs)} — ${formatRelativeTime(h.createdAt)}`,
              }))}
              width={300}
              height={28}
            />
          </div>
        </CardPanel>
      </Card>

      <h2 className="mb-2 font-semibold text-sm text-muted-foreground">
        Duration (oldest → newest)
      </h2>
      <DurationChart
        points={[...history].reverse().map((h) => ({
          durationMs: h.durationMs,
          label: `${formatDuration(h.durationMs)} — ${formatRelativeTime(h.createdAt)}`,
        }))}
        width={600}
        height={120}
      />

      <h2 className="mt-8 mb-3 font-semibold text-lg">Recent results</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Commit</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.map((h) => (
            <TableRow key={h.testResultId}>
              <TableCell>
                <a href={`${base}/runs/${h.runId}/tests/${h.testResultId}`}>
                  <StatusBadge status={h.status} />
                </a>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(h.createdAt)}
              </TableCell>
              <TableCell>{h.branch ?? "-"}</TableCell>
              <TableCell className="font-mono text-xs">
                {h.commitSha?.slice(0, 7) ?? "-"}
              </TableCell>
              <TableCell>{formatDuration(h.durationMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
