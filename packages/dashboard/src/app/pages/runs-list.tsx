import { desc, eq } from "drizzle-orm";
import { StatusBadge } from "@/app/components/status-badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { runs } from "@/db/schema";
import { getActiveProject } from "@/lib/active-project";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

export async function RunsListPage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const db = getDb();
  const allRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.projectId, project.id))
    .orderBy(desc(runs.createdAt))
    .limit(50);

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-8">
      <h1 className="mb-6 font-semibold text-2xl">Test Runs</h1>
      {allRuns.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No test runs yet</EmptyTitle>
            <EmptyDescription>
              Upload your first Playwright report using the CLI.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-xs">
              npx @wrightful/cli upload ./playwright-report.json
            </code>
          </EmptyContent>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Commit</TableHead>
              <TableHead>Tests</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allRuns.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <a href={`${base}/runs/${run.id}`}>
                    <StatusBadge status={run.status} />
                  </a>
                </TableCell>
                <TableCell>
                  <a
                    href={`${base}/runs/${run.id}`}
                    className="hover:underline"
                  >
                    {run.branch || "-"}
                  </a>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {run.commitSha?.slice(0, 7) || "-"}
                </TableCell>
                <TableCell>
                  <span className="text-success-foreground">{run.passed}</span>
                  {run.failed > 0 && (
                    <span className="text-destructive-foreground">
                      {" / "}
                      {run.failed}
                    </span>
                  )}
                  {run.flaky > 0 && (
                    <span className="text-warning-foreground">
                      {" / "}
                      {run.flaky}
                    </span>
                  )}
                  {run.skipped > 0 && (
                    <span className="text-muted-foreground">
                      {" / "}
                      {run.skipped}
                    </span>
                  )}
                </TableCell>
                <TableCell>{formatDuration(run.durationMs)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRelativeTime(run.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
