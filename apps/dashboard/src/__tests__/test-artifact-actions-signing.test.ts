import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * `signArtifactRows` (via the exported `loadAttemptArtifactGroups`) must ALWAYS
 * project a trace's `traceViewerUrl` to the SELF-HOSTED, same-origin viewer —
 * never `trace.playwright.dev` and never a bare presigned R2 URL. The rail
 * embeds this URL in an iframe, and our page CSP (`default-src 'self'`) frames
 * only same-origin documents, so a cross-origin viewer URL would render blank.
 * This invariant is unconditional now: the direct-R2 seam (ADR 0003) no longer
 * forks the embed — the viewer always wraps the same-origin worker download URL
 * (which, under direct-R2, 302s to R2 with the dashboard origin CORS-allowed).
 * `trace.playwright.dev` survives only as the dialog's "Public viewer" LINK
 * (a new tab, never framed), which this seam doesn't produce.
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

vi.mock("@/lib/artifact-tokens", () => ({
  signArtifactToken: vi.fn(async () => "TOKEN"),
  TRACE_TOKEN_TTL_SECONDS: 8 * 60 * 60,
  signedDownloadHref: (id: string, t: string) =>
    `/api/artifacts/${id}/download?t=${t}`,
  signedTraceViewerUrl: (o: string, id: string, t: string) =>
    `/trace-viewer/index.html?trace=${o}:${id}:${t}`,
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
});

describe("signArtifactRows trace-viewer URL (via loadAttemptArtifactGroups)", () => {
  it("projects a trace to the self-hosted viewer + worker download href (never a cross-origin URL)", async () => {
    const groups = await loadAttemptArtifactGroups(
      {} as never,
      "tr-1",
      "https://dash.example.com",
    );
    const action = groups.get(0)?.media[0];

    expect(action?.traceViewerUrl).toBe(
      "/trace-viewer/index.html?trace=https://dash.example.com:art-trace:TOKEN",
    );
    // The iframe-embedded URL must be same-origin: never trace.playwright.dev
    // (CSP-blocked in the frame) and never a bare presigned R2 URL (leaks r2Key).
    expect(action?.traceViewerUrl).not.toContain("trace.playwright.dev");
    expect(action?.traceViewerUrl?.startsWith("/trace-viewer/")).toBe(true);
    // The in-page download href stays the token-authed worker route.
    expect(action?.downloadHref).toBe(
      "/api/artifacts/art-trace/download?t=TOKEN",
    );
  });

  it("non-trace rows get no traceViewerUrl", async () => {
    rows = [{ ...traceRow, id: "art-shot", type: "screenshot", name: "s.png" }];
    const groups = await loadAttemptArtifactGroups({} as never, "tr-1", "o");
    expect(groups.get(0)?.media[0]?.traceViewerUrl).toBeUndefined();
  });
});
