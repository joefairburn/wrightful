import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { runs } from "@/db/schema";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, React.CSSProperties> = {
    passed: { color: "#16a34a" },
    failed: { color: "#dc2626" },
    timedout: { color: "#ea580c" },
    interrupted: { color: "#9333ea" },
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

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function RunsListPage() {
  const db = getDb();
  const allRuns = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.createdAt))
    .limit(50);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Test Runs</h1>
      {allRuns.length === 0 ? (
        <div style={{ color: "#6b7280", padding: "2rem", textAlign: "center" }}>
          <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
            No test runs yet.
          </p>
          <p>Upload your first Playwright report using the CLI:</p>
          <code
            style={{
              display: "inline-block",
              marginTop: "0.5rem",
              padding: "0.5rem 1rem",
              background: "#f3f4f6",
              borderRadius: "4px",
            }}
          >
            npx @greenroom/cli upload ./playwright-report.json
          </code>
        </div>
      ) : (
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
              <th style={{ padding: "0.5rem" }}>Branch</th>
              <th style={{ padding: "0.5rem" }}>Commit</th>
              <th style={{ padding: "0.5rem" }}>Tests</th>
              <th style={{ padding: "0.5rem" }}>Duration</th>
              <th style={{ padding: "0.5rem" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {allRuns.map((run) => (
              <tr
                key={run.id}
                style={{
                  borderBottom: "1px solid #f3f4f6",
                }}
              >
                <td style={{ padding: "0.5rem" }}>
                  <a
                    href={`/runs/${run.id}`}
                    style={{ textDecoration: "none" }}
                  >
                    <StatusBadge status={run.status} />
                  </a>
                </td>
                <td style={{ padding: "0.5rem" }}>
                  <a
                    href={`/runs/${run.id}`}
                    style={{ color: "inherit", textDecoration: "none" }}
                  >
                    {run.branch || "-"}
                  </a>
                </td>
                <td
                  style={{
                    padding: "0.5rem",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                  }}
                >
                  {run.commitSha?.slice(0, 7) || "-"}
                </td>
                <td style={{ padding: "0.5rem" }}>
                  <span style={{ color: "#16a34a" }}>{run.passed}</span>
                  {run.failed > 0 && (
                    <span style={{ color: "#dc2626" }}>
                      {" / "}
                      {run.failed}
                    </span>
                  )}
                  {run.flaky > 0 && (
                    <span style={{ color: "#ea580c" }}>
                      {" / "}
                      {run.flaky}
                    </span>
                  )}
                  {run.skipped > 0 && (
                    <span style={{ color: "#9ca3af" }}>
                      {" / "}
                      {run.skipped}
                    </span>
                  )}
                </td>
                <td style={{ padding: "0.5rem" }}>
                  {formatDuration(run.durationMs)}
                </td>
                <td style={{ padding: "0.5rem", color: "#6b7280" }}>
                  {formatRelativeTime(run.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
