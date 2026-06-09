"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/time-format";

/**
 * Pick the duration to display. While a run is in progress the stored
 * `durationMs` isn't wall-clock yet (it's 0 / accumulated test time until
 * `completeRun` writes the reporter's final value), so a running run shows
 * **wall-clock elapsed since it started** (`createdAt`); a finished run shows its
 * authoritative `durationMs`. Pure so the running/terminal switch is unit-tested
 * without React or a clock.
 *
 * `createdAt` is unix SECONDS (run row); `nowMs`/return are MILLISECONDS.
 * `nowMs === null` means "not ticking yet" (pre-mount / terminal) → fall back to
 * the stored value, which keeps the first paint deterministic for hydration.
 */
export function displayDurationMs(args: {
  status: string;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
  nowMs: number | null;
}): number {
  const running = args.status === "running" && args.completedAt == null;
  if (running && args.nowMs != null) {
    return Math.max(0, args.nowMs - args.createdAt * 1000);
  }
  return args.durationMs;
}

/**
 * Run duration cell shared by the runs list + the run-detail header. For a
 * running run it ticks elapsed-since-start every second; the moment the WS
 * delivers the terminal summary (`status` leaves "running" / `completedAt` set)
 * it switches to the final `durationMs`.
 *
 * The timer starts only after mount and only while running, so the first
 * (SSR + hydration) paint renders the stored `durationMs` deterministically —
 * no server/client mismatch — and terminal runs never start an interval.
 */
export function LiveDuration({
  status,
  durationMs,
  createdAt,
  completedAt,
}: {
  status: string;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
}): React.ReactElement {
  const running = status === "running" && completedAt == null;
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!running) {
      setNowMs(null);
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <>
      {formatDuration(
        displayDurationMs({
          status,
          durationMs,
          createdAt,
          completedAt,
          nowMs,
        }),
      )}
    </>
  );
}
