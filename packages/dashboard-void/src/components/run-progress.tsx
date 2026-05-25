import {
  useRunProgress,
  type RunProgressSummary,
  type RunProgressTest,
} from "@/lib/live-client";
import { StatusBadge } from "@/components/status-badge";

interface RunProgressProps {
  /** Run id used as the `void/live` topic suffix (`run:<runId>`). */
  runId: string;
  /** SSR-loaded test rows. Forwarded to the hook to seed its accumulator. */
  initialTests?: RunProgressTest[];
  /** SSR-loaded aggregate. Forwarded to the hook so counts render pre-event. */
  initialSummary?: RunProgressSummary;
}

/**
 * Run-detail body. Subscribes to live progress events for `run:<runId>` via
 * `useRunProgress`, merging the streaming updates on top of the SSR-loaded
 * `initialTests`/`initialSummary`. The full UI (status tiles, file-grouped
 * test list, error blocks, artifact rail) is a port-in-progress — this
 * minimal version renders summary + tests table so the page is functional
 * during the migration.
 *
 * TODO(void-migration): port the 900-line rwsdk version with the full
 * test-tree, attempt tabs, artifact actions, and status filter URL state.
 * The old version coupled the rendering to `useSyncedState<RunSummary |
 * RunTestsTail>` and a per-room split between summary + test-tail
 * channels; the new design uses a single `run:<runId>` topic with a
 * unified `RunProgressEvent` payload, so the rewrite isn't a 1:1 line port.
 */
export function RunProgress({
  runId,
  initialTests,
  initialSummary,
}: RunProgressProps) {
  // Seeds are now handed to the hook itself so the accumulator is populated
  // from the SSR snapshot before any event arrives; this component just reads.
  const { byId, summary } = useRunProgress(runId, {
    initialTests,
    initialSummary,
  });
  const tests = Object.values(byId);
  const current = summary;

  return (
    <section className="space-y-6">
      {current && (
        <header className="flex flex-wrap items-baseline gap-4 text-sm">
          <span>
            <strong>{current.totalTests}</strong> tests
          </span>
          <span className="text-emerald-600">{current.passed} passed</span>
          <span className="text-rose-600">{current.failed} failed</span>
          <span className="text-amber-600">{current.flaky} flaky</span>
          <span className="text-muted-foreground">
            {current.skipped} skipped
          </span>
          <span className="ml-auto text-muted-foreground">
            {Math.round(current.durationMs / 1000)}s · {current.status}
          </span>
        </header>
      )}

      <ul className="divide-border divide-y">
        {tests.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
            <StatusBadge status={t.status} />
            <span className="text-muted-foreground font-mono text-xs">
              {t.file}
            </span>
            <span className="truncate">{t.title}</span>
            <span className="text-muted-foreground ml-auto">
              {t.durationMs}ms
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
