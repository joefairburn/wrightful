import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { runs, testResults } from "@/db/schema";
import { requestInfo } from "rwsdk/worker";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, React.CSSProperties> = {
    passed: { color: "#16a34a" },
    failed: { color: "#dc2626" },
    flaky: { color: "#ea580c" },
    skipped: { color: "#9ca3af" },
    timedout: { color: "#ea580c" },
  };
  return (
    <span style={colors[status] || { color: "#6b7280" }}>
      {status.toUpperCase()}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export async function RunDetailPage() {
  // rwsdk types params as DefaultAppContext; widen to access route params
  const runId = String((requestInfo.params as Record<string, unknown>)["id"]);

  const db = getDb();

  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);

  if (!run) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>Run not found</h1>
        <a href="/">Back to runs</a>
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
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <a href="/" style={{ color: "#6b7280", textDecoration: "none" }}>
          &larr; All runs
        </a>
      </div>

      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Run Detail</h1>

      {/* Summary */}
      <div
        style={{
          display: "flex",
          gap: "2rem",
          marginBottom: "1.5rem",
          padding: "1rem",
          background: "#f9fafb",
          borderRadius: "8px",
        }}
      >
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Status</div>
          <StatusBadge status={run.status} />
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Tests</div>
          <div>{run.totalTests}</div>
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Passed</div>
          <div style={{ color: "#16a34a" }}>{run.passed}</div>
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Failed</div>
          <div style={{ color: "#dc2626" }}>{run.failed}</div>
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Flaky</div>
          <div style={{ color: "#ea580c" }}>{run.flaky}</div>
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Skipped</div>
          <div style={{ color: "#9ca3af" }}>{run.skipped}</div>
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Duration</div>
          <div>{formatDuration(run.durationMs)}</div>
        </div>
        {run.branch && (
          <div>
            <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Branch</div>
            <div>{run.branch}</div>
          </div>
        )}
        {run.commitSha && (
          <div>
            <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Commit</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
              {run.commitSha.slice(0, 7)}
            </div>
          </div>
        )}
      </div>

      {run.commitMessage && (
        <p style={{ color: "#374151", marginBottom: "1rem" }}>
          {run.commitMessage}
        </p>
      )}

      {/* Test Results */}
      <h2
        style={{
          fontSize: "1.1rem",
          marginBottom: "0.75rem",
          marginTop: "1.5rem",
        }}
      >
        Test Results ({results.length})
      </h2>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.875rem",
        }}
      >
        <thead>
          <tr
            style={{
              borderBottom: "2px solid #e5e7eb",
              textAlign: "left",
            }}
          >
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>Test</th>
            <th style={{ padding: "0.5rem" }}>File</th>
            <th style={{ padding: "0.5rem" }}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              <td style={{ padding: "0.5rem" }}>
                <StatusBadge status={result.status} />
              </td>
              <td style={{ padding: "0.5rem" }}>
                {result.title}
                {result.retryCount > 0 && (
                  <span
                    style={{
                      marginLeft: "0.5rem",
                      fontSize: "0.75rem",
                      color: "#9ca3af",
                    }}
                  >
                    (retry {result.retryCount})
                  </span>
                )}
              </td>
              <td
                style={{
                  padding: "0.5rem",
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                  color: "#6b7280",
                }}
              >
                {result.file}
              </td>
              <td style={{ padding: "0.5rem" }}>
                {formatDuration(result.durationMs)}
              </td>
            </tr>
          ))}
          {results.length > 0 &&
            results
              .filter(
                (r) =>
                  r.errorMessage &&
                  (r.status === "failed" || r.status === "timedout"),
              )
              .map((result) => (
                <tr key={`${result.id}-error`}>
                  <td colSpan={4}>
                    <div
                      style={{
                        padding: "0.75rem",
                        margin: "0.25rem 0",
                        background: "#fef2f2",
                        borderRadius: "4px",
                        fontSize: "0.8rem",
                      }}
                    >
                      <strong>{result.title}</strong>
                      <pre
                        style={{
                          marginTop: "0.25rem",
                          whiteSpace: "pre-wrap",
                          color: "#991b1b",
                          fontFamily: "monospace",
                        }}
                      >
                        {result.errorMessage}
                      </pre>
                    </div>
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
