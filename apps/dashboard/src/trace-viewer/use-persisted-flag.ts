"use client";

import { useState } from "react";

/**
 * Boolean UI preference persisted to localStorage (best-effort — private
 * windows and blocked storage fall back to in-memory state). Used for the
 * trace viewer's sticky toggles (e.g. canvas-from-screenshot, group
 * visibility). The read happens once at mount; cross-tab sync is
 * intentionally not attempted.
 */
export function usePersistedFlag(
  key: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {
      // Storage unavailable — fall through to the default.
    }
    return defaultValue;
  });

  const set = (next: boolean): void => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Best-effort persistence only.
    }
  };

  return [value, set];
}
