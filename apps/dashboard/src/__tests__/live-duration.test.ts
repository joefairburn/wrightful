import { describe, it, expect } from "vite-plus/test";
import { displayDurationMs } from "@/components/live-duration";

/**
 * `displayDurationMs` is the running-vs-terminal switch behind `<LiveDuration>`:
 * a running run shows wall-clock elapsed since `createdAt` (the stored
 * `durationMs` isn't wall-clock until completion); a finished run shows its
 * authoritative `durationMs`. `createdAt` is unix SECONDS, `nowMs`/return are ms.
 */
describe("displayDurationMs", () => {
  const CREATED_S = 1_700_000_000; // unix seconds
  const CREATED_MS = CREATED_S * 1000;

  it("running: returns wall-clock elapsed since createdAt", () => {
    expect(
      displayDurationMs({
        status: "running",
        durationMs: 0,
        createdAt: CREATED_S,
        completedAt: null,
        nowMs: CREATED_MS + 42_000,
      }),
    ).toBe(42_000);
  });

  it("running but not yet ticking (nowMs null): falls back to stored durationMs (deterministic first paint)", () => {
    expect(
      displayDurationMs({
        status: "running",
        durationMs: 123,
        createdAt: CREATED_S,
        completedAt: null,
        nowMs: null,
      }),
    ).toBe(123);
  });

  it("terminal: returns the authoritative durationMs, ignoring the clock", () => {
    expect(
      displayDurationMs({
        status: "failed",
        durationMs: 5_000,
        createdAt: CREATED_S,
        completedAt: CREATED_S + 5,
        nowMs: CREATED_MS + 999_999,
      }),
    ).toBe(5_000);
  });

  it("treats a set completedAt as done even if status still reads running (race)", () => {
    expect(
      displayDurationMs({
        status: "running",
        durationMs: 7_777,
        createdAt: CREATED_S,
        completedAt: CREATED_S + 7,
        nowMs: CREATED_MS + 999_999,
      }),
    ).toBe(7_777);
  });

  it("clamps a clock-skew negative elapsed to 0", () => {
    expect(
      displayDurationMs({
        status: "running",
        durationMs: 0,
        createdAt: CREATED_S,
        completedAt: null,
        nowMs: CREATED_MS - 5_000,
      }),
    ).toBe(0);
  });
});
