import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * `signArtifactRows` (via the exported `loadAttemptArtifactGroups`) mints a
 * signed, token-authed WORKER download href per row — never the raw `r2Key`.
 * Trace rows get the longer `TRACE_TOKEN_TTL_SECONDS` token (the Replay
 * viewer's SW range-reads the zip lazily for the whole modal session).
 *
 * This seam does NOT mint a self-hosted trace-viewer URL. It used to (a
 * `traceViewerUrl` field on `SignedArtifact`/`ArtifactAction`), but the
 * field's only consumers — the rail button, the replay dialog — only ever
 * checked its truthiness, which is exactly `type === "trace"`; callers that
 * need the actual viewer LINK derive it client-side from `href` via
 * `selfHostedTraceViewerUrl`. That helper's own URL shape (same-origin,
 * never `trace.playwright.dev`) is covered directly in
 * `artifact-tokens.workers.test.ts`, not here.
 */

let rows: unknown[] = [];
const builder = {
  from: () => builder,
  where: () => builder,
  orderBy: () => Promise.resolve(rows),
};
vi.mock("void/db", () => ({
  db: { select: () => builder },
  asc: (x: unknown) => x,
}));
vi.mock("void/env", () => ({ env: {} }));
// Real @schema (pure Drizzle table defs) loads fine; only the scope where-builder
// is stubbed so the bare void/db mock doesn't need the and/eq operators.
vi.mock("@/lib/scope", () => ({ childByTestResultWhere: () => ({}) }));

const signArtifactTokenMock = vi.fn(async () => "TOKEN");
vi.mock("@/lib/artifact-tokens", () => ({
  signArtifactToken: signArtifactTokenMock,
  TRACE_TOKEN_TTL_SECONDS: 8 * 60 * 60,
  signedDownloadHref: (id: string, t: string) =>
    `/api/artifacts/${id}/download?t=${t}`,
}));

const { loadAttemptArtifactGroups } =
  await import("@/lib/test-artifact-actions");

const traceRow = {
  id: "art-trace",
  testResultId: "tr-1",
  type: "trace",
  name: "trace.zip",
  contentType: "application/zip",
  attempt: 0,
  r2Key: "t/x/p/y/runs/r/tr-1/art-trace/trace.zip",
  role: null,
  snapshotName: null,
};

beforeEach(() => {
  rows = [traceRow];
  signArtifactTokenMock.mockClear();
});

describe("signArtifactRows (via loadAttemptArtifactGroups)", () => {
  it("mints the token-authed worker download href, never the raw r2Key or a traceViewerUrl field", async () => {
    const groups = await loadAttemptArtifactGroups({} as never, "tr-1");
    const action = groups.get(0)?.media[0];

    expect(action?.downloadHref).toBe(
      "/api/artifacts/art-trace/download?t=TOKEN",
    );
    expect(action?.downloadHref).not.toContain(traceRow.r2Key);
    // Regression guard: `traceViewerUrl` used to be minted here and was only
    // ever consumed as a truthiness gate equivalent to `type === "trace"` —
    // it must not reappear on the produced action.
    expect(action).not.toHaveProperty("traceViewerUrl");
  });

  it("signs trace rows with the longer TRACE_TOKEN_TTL_SECONDS, other types with the default TTL", async () => {
    rows = [
      traceRow,
      {
        ...traceRow,
        id: "art-shot",
        type: "screenshot",
        name: "s.png",
        r2Key: "t/x/p/y/runs/r/tr-1/art-shot/s.png",
      },
    ];

    await loadAttemptArtifactGroups({} as never, "tr-1");

    expect(signArtifactTokenMock).toHaveBeenNthCalledWith(
      1,
      { r2Key: traceRow.r2Key, contentType: traceRow.contentType },
      8 * 60 * 60,
    );
    expect(signArtifactTokenMock).toHaveBeenNthCalledWith(
      2,
      {
        r2Key: "t/x/p/y/runs/r/tr-1/art-shot/s.png",
        contentType: "application/zip",
      },
      undefined,
    );
  });
});
