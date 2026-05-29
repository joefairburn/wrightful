import { useEffect, useMemo, useState } from "react";
import { connectLiveStream } from "void/live/client";
import type { RunProgressEvent, RunProgressTest } from "@/live";

/**
 * Wire-format alias for downstream consumers (replaces the
 * `RunProgressTest` import that components used to pull from
 * `@/routes/api/progress` in the rwsdk codebase).
 */
export type { RunProgressTest, RunProgressEvent };
export type RunProgressTestStatus = RunProgressTest["status"];
export type RunProgressSummary = RunProgressEvent["summary"];

/**
 * Legacy alias — the rwsdk version had `useSyncedState(roomId)`. The Void
 * equivalent is `useRunProgress(runId)`; this re-export keeps existing
 * component imports working until they're rewritten one by one.
 */
export { useRunProgress as useSyncedState };

export interface UseRunProgressOptions {
  /** SSR-loaded test rows used to seed the accumulator before the first event. */
  initialTests?: readonly RunProgressTest[];
  /** SSR-loaded aggregate so consumers can render counts before the first event. */
  initialSummary?: RunProgressSummary | null;
}

/**
 * Subscribe to live updates for a single run. Returns the current
 * accumulator (map of testResultId → latest row) plus the most recent
 * summary snapshot. Replaces the old `useSyncedState`/`SyncedStateServer`
 * pattern with `void/live` topic subscriptions.
 *
 * Topic is `run:<runId>` — see `src/live.ts#onSubscribe` for the per-topic
 * auth (team membership required). Stream auto-reconnects on transient
 * network failures.
 *
 * Pass `initialTests` / `initialSummary` from the page loader so finished
 * runs and pre-hydration first-paint render with data instead of waiting
 * for the first event (which never arrives for a completed run).
 */
export function useRunProgress(
  runId: string,
  options: UseRunProgressOptions = {},
) {
  const { initialTests, initialSummary } = options;

  const seedById = useMemo(() => {
    const next: Record<string, RunProgressTest> = {};
    if (initialTests) {
      for (const t of initialTests) next[t.id] = t;
    }
    return next;
    // Seed is taken at mount; subsequent prop changes are intentionally
    // ignored so live events aren't overwritten by stale SSR data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const [byId, setById] = useState<Record<string, RunProgressTest>>(seedById);
  const [summary, setSummary] = useState<RunProgressSummary | null>(
    initialSummary ?? null,
  );

  useEffect(() => {
    const stream = connectLiveStream("/live", {
      withCredentials: true,
      retryDelay: 1000,
    });
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;

    void (async () => {
      const off = await stream.subscribe({
        id: `run:${runId}`,
        topic: `run:${runId}`,
        onEvent(event) {
          if (cancelled) return;
          if (event.type !== "progress") return;
          const data = event.data as RunProgressEvent;
          setSummary(data.summary);
          if (data.changedTests.length === 0) return;
          setById((prev) => {
            const next = { ...prev };
            for (const t of data.changedTests) {
              next[t.id] = t;
            }
            return next;
          });
        },
      });
      unsubscribe = off;
    })();

    return () => {
      cancelled = true;
      void unsubscribe?.();
      stream.close();
    };
  }, [runId]);

  return { byId, summary };
}
