import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { runs, testResults } from "@/db/schema";
import { Sparkline } from "@/app/components/sparkline";
import { DurationChart } from "@/app/components/duration-chart";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import { param } from "@/lib/route-params";
import { statusColor, type Status } from "@/lib/status";

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

export async function TestHistoryPage() {
  const testId = param("testId");

  const db = getDb();

  // Left join runs for branch/commit context on each point
  const history = await db
    .select({
      testResultId: testResults.id,
      runId: testResults.runId,
      status: testResults.status,
      title: testResults.title,
      file: testResults.file,
      projectName: testResults.projectName,
      durationMs: testResults.durationMs,
      createdAt: testResults.createdAt,
      branch: runs.branch,
      commitSha: runs.commitSha,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(eq(testResults.testId, testId))
    .orderBy(desc(testResults.createdAt))
    .limit(HISTORY_LIMIT);

  if (history.length === 0) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>No history for this test</h1>
        <p style={{ color: "#6b7280" }}>
          This test identifier has no recorded runs. If you recently renamed the
          test, file, or project, it will appear as a new test id.
        </p>
        <a href="/">Back to runs</a>
      </div>
    );
  }

  const mostRecent = history[0];
  const { ran, failed, flaky, pct } = flakinessPercent(history);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <a
          href={`/runs/${mostRecent.runId}/tests/${mostRecent.testResultId}`}
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          &larr; Back to latest run
        </a>
      </div>

      <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.25rem" }}>
        {mostRecent.title}
      </h1>
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "0.85rem",
          color: "#6b7280",
          marginBottom: "1.5rem",
        }}
      >
        {mostRecent.file}
        {mostRecent.projectName && ` · ${mostRecent.projectName}`}
      </div>

      {/* Summary */}
      <div
        style={{
          display: "flex",
          gap: "2rem",
          padding: "1rem",
          background: "#f9fafb",
          borderRadius: "8px",
          marginBottom: "1.5rem",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>
            Last {ran} runs
          </div>
          <div
            style={{
              fontSize: "1.5rem",
              fontWeight: 600,
              color: pct >= 20 ? "#dc2626" : pct > 0 ? "#ea580c" : "#16a34a",
            }}
          >
            {pct}%
          </div>
          <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>
            {failed} failed · {flaky} flaky
          </div>
        </div>
        <div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>
            Status timeline (oldest → newest)
          </div>
          <Sparkline
            points={[...history].reverse().map((h) => ({
              status: h.status as Status,
              label: `${h.status} — ${formatDuration(h.durationMs)} — ${formatRelativeTime(h.createdAt)}`,
            }))}
            width={300}
            height={28}
          />
        </div>
      </div>

      {/* Duration trend */}
      <h2
        style={{
          fontSize: "1rem",
          marginBottom: "0.5rem",
          color: "#374151",
        }}
      >
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

      {/* Run list */}
      <h2
        style={{
          fontSize: "1.1rem",
          marginBottom: "0.5rem",
          marginTop: "1.5rem",
        }}
      >
        Recent results
      </h2>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.875rem",
        }}
      >
        <thead>
          <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>When</th>
            <th style={{ padding: "0.5rem" }}>Branch</th>
            <th style={{ padding: "0.5rem" }}>Commit</th>
            <th style={{ padding: "0.5rem" }}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr
              key={h.testResultId}
              style={{ borderBottom: "1px solid #f3f4f6" }}
            >
              <td style={{ padding: "0.5rem" }}>
                <a
                  href={`/runs/${h.runId}/tests/${h.testResultId}`}
                  style={{
                    color: statusColor(h.status),
                    textDecoration: "none",
                  }}
                >
                  {h.status.toUpperCase()}
                </a>
              </td>
              <td style={{ padding: "0.5rem", color: "#6b7280" }}>
                {formatRelativeTime(h.createdAt)}
              </td>
              <td style={{ padding: "0.5rem" }}>{h.branch ?? "-"}</td>
              <td
                style={{
                  padding: "0.5rem",
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                }}
              >
                {h.commitSha?.slice(0, 7) ?? "-"}
              </td>
              <td style={{ padding: "0.5rem" }}>
                {formatDuration(h.durationMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
