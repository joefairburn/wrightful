import { and, eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { StatusBadge } from "@/app/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/app/components/ui/alert";
import { Badge } from "@/app/components/ui/badge";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import {
  artifacts,
  runs,
  testAnnotations,
  testResults,
  testTags,
} from "@/db/schema";
import { getActiveProject } from "@/lib/active-project";
import { param } from "@/lib/route-params";
import { formatDuration } from "@/lib/time-format";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Artifact {
  id: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

/** Build a trace.playwright.dev link wrapping a presigned R2 GET URL.
 *
 * Our own download endpoint 302s to the presigned R2 URL. trace.playwright.dev
 * follows the redirect and loads the underlying .zip.
 *
 * NOTE: this is a link-out for now. A self-hosted trace-viewer component is
 * tracked for Phase 5 so teams running Wrightful behind a corporate firewall
 * (where trace.playwright.dev may not be reachable) aren't blocked. */
function traceViewerUrl(origin: string, artifactId: string): string {
  const downloadUrl = `${origin}/api/artifacts/${artifactId}/download`;
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(downloadUrl)}`;
}

export async function TestDetailPage() {
  const runId = param("runId");
  const testResultId = param("testResultId");
  const origin = new URL(requestInfo.request.url).origin;

  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const db = getDb();

  // Single-join verifies ownership AND fetches both rows, scoped to project.
  const rows = await db
    .select({
      run: runs,
      result: testResults,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(
      and(
        eq(testResults.id, testResultId),
        eq(testResults.runId, runId),
        eq(runs.projectId, project.id),
      ),
    )
    .limit(1);

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (rows.length === 0) {
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

  const { run, result } = rows[0];

  const [tagRows, annotationRows, artifactRows] = await Promise.all([
    db
      .select({ tag: testTags.tag })
      .from(testTags)
      .where(eq(testTags.testResultId, testResultId)),
    db
      .select({
        type: testAnnotations.type,
        description: testAnnotations.description,
      })
      .from(testAnnotations)
      .where(eq(testAnnotations.testResultId, testResultId)),
    db
      .select({
        id: artifacts.id,
        type: artifacts.type,
        name: artifacts.name,
        contentType: artifacts.contentType,
        sizeBytes: artifacts.sizeBytes,
      })
      .from(artifacts)
      .where(eq(artifacts.testResultId, testResultId)),
  ]);

  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-8">
      <div className="mb-2">
        <a
          href={`${base}/runs/${runId}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; Back to run
        </a>
      </div>

      <div className="mb-2 flex items-center gap-3">
        <StatusBadge status={result.status} />
        <h1 className="font-semibold text-xl">{result.title}</h1>
      </div>
      <div className="mb-5 font-mono text-muted-foreground text-sm">
        {result.file}
        {result.projectName && ` · ${result.projectName}`} ·{" "}
        {formatDuration(result.durationMs)}
        {result.retryCount > 0 && ` · ${result.retryCount} retries`}
      </div>

      {run.commitMessage && (
        <p className="mb-5 text-sm">
          <span className="text-muted-foreground">commit: </span>
          {run.commitMessage}
        </p>
      )}

      <div className="mb-5">
        <a
          href={`${base}/tests/${result.testId}`}
          className="text-foreground text-sm underline-offset-4 hover:underline"
        >
          View history for this test &rarr;
        </a>
      </div>

      {(tagRows.length > 0 || annotationRows.length > 0) && (
        <div className="mb-5 flex flex-wrap gap-2">
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

      {result.errorMessage && (
        <Alert variant="error" className="mb-5">
          <AlertTitle>{result.errorMessage.split("\n")[0]}</AlertTitle>
          {result.errorStack && (
            <AlertDescription>
              <pre className="whitespace-pre-wrap font-mono text-xs">
                {result.errorStack}
              </pre>
            </AlertDescription>
          )}
        </Alert>
      )}

      <h2 className="mt-8 mb-3 font-semibold text-lg">
        Artifacts ({artifactRows.length})
      </h2>
      {artifactRows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No artifacts were uploaded for this test.
        </p>
      ) : (
        <ul className="divide-y border-y">
          {artifactRows.map((a: Artifact) => (
            <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
              <Badge variant="outline" size="sm">
                {a.type.toUpperCase()}
              </Badge>
              <a
                href={`/api/artifacts/${a.id}/download`}
                className="text-foreground underline-offset-4 hover:underline"
              >
                {a.name}
              </a>
              <span className="text-muted-foreground text-xs">
                {formatBytes(a.sizeBytes)}
              </span>
              {a.type === "trace" && (
                <a
                  href={traceViewerUrl(origin, a.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-foreground text-xs underline-offset-4 hover:underline"
                >
                  Open in Playwright Trace Viewer &rarr;
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
