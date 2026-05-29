import { describe, it, expect } from "vite-plus/test";
import { mergeRunStatus } from "@/lib/ingest";

/**
 * Guards the sharding fix in completeRun: shards share one idempotencyKey and
 * call /complete in arbitrary order, so the run's terminal status must be the
 * worst outcome across shards — a later all-passing shard must never overwrite
 * an earlier failure.
 */
describe("mergeRunStatus", () => {
  it("takes the incoming status verbatim on the first completion (running)", () => {
    expect(mergeRunStatus("running", "passed")).toBe("passed");
    expect(mergeRunStatus("running", "failed")).toBe("failed");
    expect(mergeRunStatus("running", "interrupted")).toBe("interrupted");
  });

  it("never downgrades a failed run to passed", () => {
    expect(mergeRunStatus("failed", "passed")).toBe("failed");
    expect(mergeRunStatus("timedout", "passed")).toBe("timedout");
    expect(mergeRunStatus("interrupted", "passed")).toBe("interrupted");
  });

  it("escalates to a more severe outcome", () => {
    expect(mergeRunStatus("passed", "failed")).toBe("failed");
    expect(mergeRunStatus("passed", "interrupted")).toBe("interrupted");
    expect(mergeRunStatus("flaky", "failed")).toBe("failed");
    expect(mergeRunStatus("skipped", "passed")).toBe("passed");
  });

  it("keeps the more severe of two terminal statuses regardless of arrival order", () => {
    expect(mergeRunStatus("failed", "interrupted")).toBe("failed");
    expect(mergeRunStatus("interrupted", "failed")).toBe("failed");
  });

  it("is stable when both statuses are equally severe", () => {
    // failed and timedout share severity — keep the current one (no flip-flop).
    expect(mergeRunStatus("failed", "timedout")).toBe("failed");
    expect(mergeRunStatus("timedout", "failed")).toBe("timedout");
    expect(mergeRunStatus("passed", "passed")).toBe("passed");
  });
});
