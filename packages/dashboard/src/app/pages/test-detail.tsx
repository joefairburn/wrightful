import { and, eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import {
  artifacts,
  runs,
  testAnnotations,
  testResults,
  testTags,
} from "@/db/schema";
import { StatusBadge } from "@/app/components/status-badge";
import { formatDuration } from "@/lib/time-format";
import { param } from "@/lib/route-params";

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
 * tracked for Phase 5 so teams running Greenroom behind a corporate firewall
 * (where trace.playwright.dev may not be reachable) aren't blocked. */
function traceViewerUrl(origin: string, artifactId: string): string {
  const downloadUrl = `${origin}/api/artifacts/${artifactId}/download`;
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(downloadUrl)}`;
}

export async function TestDetailPage() {
  const runId = param("runId");
  const testResultId = param("testResultId");
  const origin = new URL(requestInfo.request.url).origin;

  const db = getDb();

  // Single-join verifies ownership AND fetches both rows
  const rows = await db
    .select({
      run: runs,
      result: testResults,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(and(eq(testResults.id, testResultId), eq(testResults.runId, runId)))
    .limit(1);

  if (rows.length === 0) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>Test not found</h1>
        <a href={`/runs/${runId}`}>Back to run</a>
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
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <a
          href={`/runs/${runId}`}
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          &larr; Back to run
        </a>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "0.5rem",
        }}
      >
        <StatusBadge status={result.status} />
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>{result.title}</h1>
      </div>
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "0.85rem",
          color: "#6b7280",
          marginBottom: "1.25rem",
        }}
      >
        {result.file}
        {result.projectName && ` · ${result.projectName}`} ·{" "}
        {formatDuration(result.durationMs)}
        {result.retryCount > 0 && ` · ${result.retryCount} retries`}
      </div>

      {run.commitMessage && (
        <p style={{ color: "#374151", marginBottom: "1.25rem" }}>
          <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>
            commit:{" "}
          </span>
          {run.commitMessage}
        </p>
      )}

      <div style={{ marginBottom: "1.25rem" }}>
        <a
          href={`/tests/${result.testId}`}
          style={{ fontSize: "0.875rem", color: "#2563eb" }}
        >
          View history for this test &rarr;
        </a>
      </div>

      {(tagRows.length > 0 || annotationRows.length > 0) && (
        <div
          style={{
            marginBottom: "1.25rem",
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          {tagRows.map((t, i) => (
            <span
              key={`tag-${i}`}
              style={{
                padding: "0.15rem 0.5rem",
                borderRadius: "999px",
                background: "#e0e7ff",
                color: "#3730a3",
                fontSize: "0.75rem",
              }}
            >
              {t.tag}
            </span>
          ))}
          {annotationRows.map((a, i) => (
            <span
              key={`ann-${i}`}
              style={{
                padding: "0.15rem 0.5rem",
                borderRadius: "999px",
                background: "#fef3c7",
                color: "#92400e",
                fontSize: "0.75rem",
              }}
              title={a.description ?? undefined}
            >
              {a.type}
              {a.description ? `: ${a.description}` : ""}
            </span>
          ))}
        </div>
      )}

      {result.errorMessage && (
        <div
          style={{
            padding: "1rem",
            background: "#fef2f2",
            borderRadius: "6px",
            marginBottom: "1.25rem",
          }}
        >
          <div
            style={{
              fontWeight: 600,
              color: "#991b1b",
              marginBottom: "0.5rem",
            }}
          >
            {result.errorMessage.split("\n")[0]}
          </div>
          {result.errorStack && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
                fontSize: "0.8rem",
                color: "#7f1d1d",
                margin: 0,
              }}
            >
              {result.errorStack}
            </pre>
          )}
        </div>
      )}

      <h2
        style={{
          fontSize: "1.1rem",
          marginBottom: "0.5rem",
          marginTop: "1.5rem",
        }}
      >
        Artifacts ({artifactRows.length})
      </h2>
      {artifactRows.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
          No artifacts were uploaded for this test.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {artifactRows.map((a: Artifact) => (
            <li
              key={a.id}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid #f3f4f6",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  padding: "0.15rem 0.4rem",
                  background: "#f3f4f6",
                  borderRadius: "3px",
                  color: "#4b5563",
                }}
              >
                {a.type.toUpperCase()}
              </span>
              <a
                href={`/api/artifacts/${a.id}/download`}
                style={{ color: "#2563eb", textDecoration: "none" }}
              >
                {a.name}
              </a>
              <span style={{ color: "#9ca3af", fontSize: "0.8rem" }}>
                {formatBytes(a.sizeBytes)}
              </span>
              {a.type === "trace" && (
                <a
                  href={traceViewerUrl(origin, a.id)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.8rem",
                    color: "#2563eb",
                  }}
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
