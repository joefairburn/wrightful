import { describe, expect, it } from "vitest";
import { type PreparedArtifact, promoteSnapshotTriples } from "../index.js";

function art(over: Partial<PreparedArtifact>): PreparedArtifact {
  return {
    type: "screenshot",
    name: "shot.png",
    contentType: "image/png",
    sizeBytes: 1,
    localPath: "/tmp/shot.png",
    attempt: 0,
    ...over,
  };
}

describe("promoteSnapshotTriples", () => {
  it("promotes a complete (expected, actual, diff) triple to type 'visual'", () => {
    const out = promoteSnapshotTriples([
      art({
        name: "hero-expected.png",
        snapshotName: "hero",
        role: "expected",
      }),
      art({ name: "hero-actual.png", snapshotName: "hero", role: "actual" }),
      art({ name: "hero-diff.png", snapshotName: "hero", role: "diff" }),
    ]);
    expect(out.every((a) => a.type === "visual")).toBe(true);
    expect(
      out.map((a) => a.role).sort((x, y) => (x ?? "").localeCompare(y ?? "")),
    ).toEqual(["actual", "diff", "expected"]);
    expect(out.every((a) => a.snapshotName === "hero")).toBe(true);
  });

  it("falls back to plain screenshot when only one of the triple is present", () => {
    const out = promoteSnapshotTriples([
      art({
        name: "lonely-actual.png",
        snapshotName: "lonely",
        role: "actual",
      }),
    ]);
    expect(out[0]).toMatchObject({
      type: "screenshot",
      role: undefined,
      snapshotName: undefined,
    });
  });

  it("falls back when only two of the three roles are present", () => {
    const out = promoteSnapshotTriples([
      art({
        name: "pair-expected.png",
        snapshotName: "pair",
        role: "expected",
      }),
      art({ name: "pair-actual.png", snapshotName: "pair", role: "actual" }),
    ]);
    expect(out.every((a) => a.type === "screenshot")).toBe(true);
    expect(out.every((a) => a.role === undefined)).toBe(true);
    expect(out.every((a) => a.snapshotName === undefined)).toBe(true);
  });

  it("groups by (attempt, snapshotName) so retries don't bleed into each other", () => {
    // Attempt 0 has a complete triple; attempt 1 only has a singleton.
    const out = promoteSnapshotTriples([
      art({ snapshotName: "hero", role: "expected", attempt: 0 }),
      art({ snapshotName: "hero", role: "actual", attempt: 0 }),
      art({ snapshotName: "hero", role: "diff", attempt: 0 }),
      art({ snapshotName: "hero", role: "actual", attempt: 1 }),
    ]);
    const a0 = out.filter((a) => a.attempt === 0);
    const a1 = out.filter((a) => a.attempt === 1);
    expect(a0.every((a) => a.type === "visual")).toBe(true);
    expect(a1[0]).toMatchObject({
      type: "screenshot",
      role: undefined,
      snapshotName: undefined,
    });
  });

  it("handles multiple distinct snapshots in one attempt — only complete groups promote", () => {
    // hero: complete (3); logo: incomplete singleton.
    // Singletons get cleared so we can't match by snapshotName afterwards —
    // distinguish via the localPath instead.
    const out = promoteSnapshotTriples([
      art({
        snapshotName: "hero",
        role: "expected",
        localPath: "/tmp/hero-e.png",
      }),
      art({
        snapshotName: "hero",
        role: "actual",
        localPath: "/tmp/hero-a.png",
      }),
      art({
        snapshotName: "hero",
        role: "diff",
        localPath: "/tmp/hero-d.png",
      }),
      art({
        snapshotName: "logo",
        role: "actual",
        localPath: "/tmp/logo-a.png",
      }),
    ]);
    const heroes = out.filter((a) => a.localPath.includes("hero"));
    expect(heroes.length).toBe(3);
    expect(heroes.every((a) => a.type === "visual")).toBe(true);
    expect(heroes.every((a) => a.snapshotName === "hero")).toBe(true);

    const logos = out.filter((a) => a.localPath.includes("logo"));
    expect(logos.length).toBe(1);
    expect(logos[0]).toMatchObject({
      type: "screenshot",
      role: undefined,
      snapshotName: undefined,
    });
  });

  it("leaves non-snapshot artifacts (trace, video, plain screenshot) alone", () => {
    const out = promoteSnapshotTriples([
      art({ type: "trace", name: "trace.zip", contentType: "application/zip" }),
      art({ type: "video", name: "clip.webm", contentType: "video/webm" }),
      art({ type: "screenshot", name: "manual.png" }),
    ]);
    expect(out.map((a) => a.type)).toEqual(["trace", "video", "screenshot"]);
  });
});
