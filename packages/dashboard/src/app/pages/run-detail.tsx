import { and, eq } from "drizzle-orm";
import type React from "react";
import { StatusBadge } from "@/app/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/app/components/ui/alert";
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
import { getDb } from "@/db";
import { runs, testResults } from "@/db/schema";
import { getActiveProject } from "@/lib/active-project";
import { param } from "@/lib/route-params";
import { formatDuration } from "@/lib/time-format";

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div>{children}</div>
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
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.projectId, project.id)))
    .limit(1);

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (!run) {
    return (
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <h1 className="mb-4 font-semibold text-2xl">Run not found</h1>
        <a href={base} className="text-muted-foreground hover:underline">
          Back to runs
        </a>
      </div>
    );
  }

  const results = await db
    .select()
    .from(testResults)
    .where(eq(testResults.runId, runId));

  // Sort: failed first, then flaky, then passed, then skipped
  const statusOrder: Record<string, number> = {
    failed: 0,
    timedout: 1,
    flaky: 2,
    passed: 3,
    skipped: 4,
  };
  results.sort(
    (a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5),
  );

  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-8">
      <div className="mb-2">
        <a
          href={base}
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; All runs
        </a>
      </div>

      <h1 className="mb-4 font-semibold text-2xl">Run Detail</h1>

      <Card className="mb-6">
        <CardPanel className="flex flex-wrap gap-x-8 gap-y-4">
          <Stat label="Status">
            <StatusBadge status={run.status} />
          </Stat>
          <Stat label="Tests">{run.totalTests}</Stat>
          <Stat label="Passed">
            <span className="text-success-foreground">{run.passed}</span>
          </Stat>
          <Stat label="Failed">
            <span className="text-destructive-foreground">{run.failed}</span>
          </Stat>
          <Stat label="Flaky">
            <span className="text-warning-foreground">{run.flaky}</span>
          </Stat>
          <Stat label="Skipped">
            <span className="text-muted-foreground">{run.skipped}</span>
          </Stat>
          <Stat label="Duration">{formatDuration(run.durationMs)}</Stat>
          {run.branch && <Stat label="Branch">{run.branch}</Stat>}
          {run.commitSha && (
            <Stat label="Commit">
              <span className="font-mono text-sm">
                {run.commitSha.slice(0, 7)}
              </span>
            </Stat>
          )}
        </CardPanel>
      </Card>

      {run.commitMessage && (
        <p className="mb-4 text-foreground text-sm">{run.commitMessage}</p>
      )}

      <h2 className="mt-8 mb-3 font-semibold text-lg">
        Test Results ({results.length})
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Test</TableHead>
            <TableHead>File</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((result) => {
            const detailHref = `${base}/runs/${runId}/tests/${result.id}`;
            return (
              <TableRow key={result.id}>
                <TableCell>
                  <a href={detailHref}>
                    <StatusBadge status={result.status} />
                  </a>
                </TableCell>
                <TableCell>
                  <a href={detailHref} className="hover:underline">
                    {result.title}
                  </a>
                  {result.retryCount > 0 && (
                    <span className="ml-2 text-muted-foreground text-xs">
                      (retry {result.retryCount})
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground text-xs">
                  {result.file}
                </TableCell>
                <TableCell>{formatDuration(result.durationMs)}</TableCell>
              </TableRow>
            );
          })}
          {results
            .filter(
              (r) =>
                r.errorMessage &&
                (r.status === "failed" || r.status === "timedout"),
            )
            .map((result) => (
              <TableRow key={`${result.id}-error`}>
                <TableCell colSpan={4} className="whitespace-normal">
                  <Alert variant="error" className="my-1">
                    <AlertTitle className="font-mono text-xs">
                      {result.title}
                    </AlertTitle>
                    <AlertDescription>
                      <pre className="whitespace-pre-wrap font-mono text-xs">
                        {result.errorMessage}
                      </pre>
                    </AlertDescription>
                  </Alert>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
