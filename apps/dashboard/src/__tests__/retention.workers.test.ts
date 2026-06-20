import { describe, expect, it } from "vite-plus/test";
import { chunkIdsForInList, resolveRetentionWindows } from "@/lib/retention";

/**
 * Pure core of the two-axis retention sweep — the per-team window resolution.
 * The DB/R2-touching `sweepRetention` is exercised end-to-end by the e2e
 * dogfood suite (per the standing real-D1-harness gap).
 */

const DEFAULTS = { artifactDays: 30, testResultDays: 90 };

describe("resolveRetentionWindows", () => {
  it("falls back to the env defaults when a team sets neither override", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: null, retentionTestResultsDays: null },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 30, testResultDays: 90 });
  });

  it("uses a team override where present, default where null", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: 7, retentionTestResultsDays: null },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 7, testResultDays: 90 });

    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: null, retentionTestResultsDays: 365 },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 30, testResultDays: 365 });
  });

  it("honors both overrides when both are set", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: 14, retentionTestResultsDays: 180 },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 14, testResultDays: 180 });
  });
});

/**
 * The IN-list chunker for the per-project delete/R2-cleanup loops. It defers the
 * bound-param ceiling to `chunkByParams` (ingest.ts) rather than carrying its own
 * magic number — this asserts the seam is wired correctly, not the cap's math
 * (the cap is covered by ingest's own chunk tests).
 */
describe("chunkIdsForInList", () => {
  it("returns no chunks for an empty id list", () => {
    expect(chunkIdsForInList([])).toEqual([]);
  });

  it("keeps a realistically-sized per-pass slice in a single chunk", () => {
    // Each id binds one param against a 65_535 ceiling, so a `.limit`-bounded
    // slice (here far larger than any real per-pass limit) never needs splitting.
    const ids = Array.from({ length: 5_000 }, (_, i) => `id-${i}`);
    const chunks = chunkIdsForInList(ids);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5_000);
  });

  it("preserves order and partitions all ids without loss or overlap", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const chunks = chunkIdsForInList(ids);
    expect(chunks.flat()).toEqual(ids);
  });

  it("reserves the fixed projectId bind: a full chunk + projectId never exceeds 65_535", () => {
    // The statement is `WHERE projectId = $1 AND id IN (chunk)`, so a full chunk
    // must leave room for the lone projectId bind: `chunk.length + 1 <= 65_535`,
    // i.e. each chunk binds at most 65_534 ids. A list one past that boundary
    // splits into a max chunk + a remainder rather than a single 65_535-id chunk
    // that would overflow once projectId is bound.
    const ids = Array.from({ length: 65_535 }, (_, i) => `id-${i}`);
    const chunks = chunkIdsForInList(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(65_534);
    expect(chunks[1]).toHaveLength(1);
    for (const chunk of chunks) {
      expect(chunk.length + 1).toBeLessThanOrEqual(65_535);
    }
    expect(chunks.flat()).toEqual(ids);
  });
});
