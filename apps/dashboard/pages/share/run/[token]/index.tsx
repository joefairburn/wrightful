import { cn } from "@/lib/cn";
import type { Props } from "./index.server";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

const STATUS_DOT: Record<string, string> = {
  passed: "bg-passed",
  failed: "bg-failed",
  timedout: "bg-failed",
  interrupted: "bg-failed",
  flaky: "bg-flaky",
  skipped: "bg-fg-4",
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        STATUS_DOT[status] ?? "bg-fg-4",
      )}
    />
  );
}

function InvalidView() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="font-semibold text-fg-1 text-lg">Link unavailable</h1>
      <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
        This share link is invalid, has expired, or was revoked. Ask the run
        owner for a fresh link.
      </p>
    </main>
  );
}

/**
 * Public read-only run view. No app chrome, no auth — rendered for anyone with
 * a valid share token. Live updates / artifacts / history are intentionally
 * omitted; this is a static snapshot of the run's results.
 */
export default function SharedRunPage(props: Props) {
  if (!props.valid) return <InvalidView />;
  const { run, tests } = props;

  const counts: Array<[string, number]> = [
    ["passed", run.passed],
    ["failed", run.failed],
    ["flaky", run.flaky],
    ["skipped", run.skipped],
  ];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-3 border-line-1 border-b pb-6">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-fg-3 uppercase tracking-wider">
            Wrightful · shared run
          </span>
        </div>
        <div className="flex items-center gap-3">
          <StatusDot status={run.status} />
          <h1 className="font-semibold text-fg-1 text-xl capitalize">
            {run.status}
          </h1>
          <span className="text-[length:var(--text-fs-13)] text-fg-3">
            {run.totalTests} tests · {formatDuration(run.durationMs)}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-fs-13)] text-fg-3">
          {counts
            .filter(([, n]) => n > 0)
            .map(([label, n]) => (
              <span key={label}>
                <span className="font-medium text-fg-1 tabular-nums">{n}</span>{" "}
                {label}
              </span>
            ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-fg-3">
          {run.branch && <span>{run.branch}</span>}
          {run.commitSha && <span>{run.commitSha.slice(0, 7)}</span>}
          {run.environment && <span>{run.environment}</span>}
        </div>
        {run.commitMessage && (
          <p className="text-[length:var(--text-fs-13)] text-fg-2">
            {run.commitMessage}
          </p>
        )}
      </header>

      <ul className="flex flex-col">
        {tests.map((t) => (
          <li
            className="flex items-center gap-3 border-line-1 border-b py-2 last:border-b-0"
            key={t.id}
          >
            <StatusDot status={t.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[length:var(--text-fs-13)] text-fg-1">
                {t.title}
              </p>
              <p className="truncate font-mono text-[11px] text-fg-3">
                {t.file}
              </p>
            </div>
            <span className="shrink-0 font-mono text-[11px] text-fg-3 tabular-nums">
              {formatDuration(t.durationMs)}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
