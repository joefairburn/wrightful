import { describe, expect, it } from "vite-plus/test";
import {
  isReplayTraceArtifact,
  selectReplayTracesByAttempt,
} from "@/lib/trace-artifacts";

describe("replay trace artifact policy", () => {
  it("accepts only Playwright's canonical trace names", () => {
    expect(isReplayTraceArtifact({ type: "trace", name: "trace" })).toBe(true);
    expect(isReplayTraceArtifact({ type: "trace", name: "trace.zip" })).toBe(
      true,
    );
    expect(
      isReplayTraceArtifact({ type: "trace", name: "diagnostics.zip" }),
    ).toBe(false);
    expect(isReplayTraceArtifact({ type: "other", name: "trace.zip" })).toBe(
      false,
    );
  });

  it("returns one trace per attempt and prefers the native attachment name", () => {
    const selected = selectReplayTracesByAttempt([
      { id: "generic", type: "trace", name: "bundle.zip", attempt: 0 },
      { id: "legacy-0", type: "trace", name: "trace.zip", attempt: 0 },
      { id: "native-1", type: "trace", name: "trace", attempt: 1 },
      { id: "legacy-1", type: "trace", name: "trace.zip", attempt: 1 },
      { id: "native-0", type: "trace", name: "trace", attempt: 0 },
    ]);

    expect(selected.map((row) => row.id)).toEqual(["native-0", "native-1"]);
  });
});
