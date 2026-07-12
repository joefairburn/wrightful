"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, PlayCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetch } from "void/client";
import type { ArtifactAction } from "@/components/artifact-actions";
import { SegmentedControl } from "@/components/segmented-control";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSearchParam } from "@/lib/use-search-param";
import { TraceViewer } from "@/trace-viewer/components/trace-viewer";
import { warmTraceViewer } from "@/trace-viewer/warm";

/**
 * URL param that drives the Replay modal so it's deep-linkable / shareable.
 * On the run's Tests tab the value is a `testResultId` (the modal is hosted
 * once by {@link ReplayModalHost}, which mints the viewer URL on demand); on
 * the test-detail artifacts rail it's an `artifactId` (the URL is already known
 * at SSR — see {@link TraceViewerDialog}). Closing clears it (the param drops
 * out of the URL entirely — see `useSearchParam`).
 */
const REPLAY_PARAM = "replay";

/** One attempt's replay links, as consumed by the switcher below. */
export interface TestReplayAttempt {
  /** 0-based, as stored — displayed as `attempt + 1`. */
  attempt: number;
  viewerUrl: string;
  downloadHref: string;
}

/**
 * Shared body of the Replay dialog: a near-full-viewport panel hosting OUR
 * trace viewer (`src/trace-viewer/` — native dashboard components on top of
 * the vendored Playwright service worker; see that folder's bridge.html for
 * the architecture). Gives Cypress-style time-travel (DOM snapshot scrubber +
 * action tree + network/console) without leaving the dashboard and without
 * the trace bytes ever reaching the public trace.playwright.dev.
 *
 * The viewer mounts only while `open`, so the SW registration + trace
 * download defer to first use and a reopened dialog loads fresh. `viewerUrl`
 * (the vendored OFFICIAL viewer at `/trace-viewer/index.html?trace=…`) is
 * kept as a new-tab fallback while our viewer matures. When 2+ `attempts` are
 * given, a compact switcher in the header lets the retries be replayed
 * individually — defaulting to the LAST one (same attempt the top-level
 * `viewerUrl`/`downloadHref` describe).
 */
function TestReplayContent({
  viewerUrl,
  downloadHref,
  title,
  attempts,
  open,
  onClose,
}: {
  viewerUrl: string;
  downloadHref: string;
  title: string;
  /**
   * Every attempt with a recorded trace, ascending. Only rendered as a
   * switcher when 2+ are present — a single-attempt test (the common case)
   * has nothing to switch between. Omitted entirely by the artifacts-rail
   * entry point, which only ever knows about the one artifact resolved at SSR.
   */
  attempts?: TestReplayAttempt[];
  open: boolean;
  /** Close the modal (clears the `?replay=` URL param). */
  onClose: () => void;
}): React.ReactElement {
  // Selected attempt defaults to the LAST one — same as the top-level
  // `viewerUrl`/`downloadHref` props describe when there's no switcher.
  const lastAttempt = attempts?.at(-1)?.attempt;
  const [selectedAttempt, setSelectedAttempt] = useState(lastAttempt);

  const active =
    attempts?.find((a) => a.attempt === selectedAttempt) ?? attempts?.at(-1);
  const activeViewerUrl = active?.viewerUrl ?? viewerUrl;
  const activeDownloadHref = active?.downloadHref ?? downloadHref;

  // The SW resolves + range-reads the trace zip itself, so it needs the
  // ABSOLUTE signed download URL. Client-only (needs `window.location`):
  // null on SSR, set on hydrate — the dialog body is client-side anyway.
  const absoluteTraceUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URL(activeDownloadHref, window.location.origin).href;
  }, [activeDownloadHref]);

  // Public-viewer fallback — opens the trace on the public trace.playwright.dev
  // in a NEW TAB (never framed, so the page CSP doesn't apply).
  const publicViewerUrl = absoluteTraceUrl
    ? `https://trace.playwright.dev/?trace=${encodeURIComponent(absoluteTraceUrl)}`
    : null;

  return (
    <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-1 py-2.5 pr-12 pl-4">
        <DialogTitle className="min-w-0 truncate text-sm font-medium">
          {title}
        </DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          {attempts && attempts.length > 1 ? (
            <SegmentedControl
              compact
              value={String(selectedAttempt ?? lastAttempt)}
              onChange={(next) => setSelectedAttempt(Number(next))}
              options={attempts.map((a) => ({
                value: String(a.attempt),
                label: `Attempt ${a.attempt + 1}`,
              }))}
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            title="Opens this trace in the official Playwright viewer (self-hosted)"
            render={
              <a href={activeViewerUrl} target="_blank" rel="noreferrer" />
            }
          >
            <ExternalLink />
            Official viewer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            render={<a href={activeDownloadHref} download />}
          >
            <Download />
            Download
          </Button>
          {publicViewerUrl ? (
            <Button
              size="sm"
              variant="ghost"
              title="Opens the public Playwright viewer — sends this trace to trace.playwright.dev"
              className="text-fg-3"
              render={
                <a href={publicViewerUrl} target="_blank" rel="noreferrer" />
              }
            >
              Public viewer
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-bg-0">
        {open && absoluteTraceUrl ? (
          // Keyed on the download href so switching attempts remounts the
          // viewer (a fresh SW load for the newly-selected trace) rather than
          // reusing the previous attempt's model.
          <TraceViewer
            key={activeDownloadHref}
            traceUrl={absoluteTraceUrl}
            onEscape={onClose}
          />
        ) : null}
      </div>
    </DialogContent>
  );
}

/**
 * Test-detail artifacts-rail entry point. The trace artifact already carries a
 * signed `traceViewerUrl` (minted in the page loader), so the dialog opens
 * directly. Open state lives in `?replay=<artifactId>` so a specific replay is
 * deep-linkable. `children` are the trigger's inner content so the rail keeps
 * ownership of the button's appearance.
 */
export function TraceViewerDialog({
  artifact,
  children,
  onTriggerPointerEnter,
}: {
  artifact: ArtifactAction;
  children: React.ReactNode;
  /** Fired on hover/touch-start of the trigger — lets the rail warm the SW +
   * prefetch this artifact's trace ahead of the click (see `RailTraceButton`
   * in `artifacts-rail.tsx`). */
  onTriggerPointerEnter?: () => void;
}): React.ReactElement {
  const [replay, setReplay] = useSearchParam(REPLAY_PARAM, "");
  const viewerUrl = artifact.traceViewerUrl;
  if (!viewerUrl) return <></>;

  const open = replay === artifact.id;
  const close = (): void => setReplay("");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setReplay(artifact.id) : close())}
    >
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-between"
            onPointerEnter={onTriggerPointerEnter}
          />
        }
      >
        {children}
      </DialogTrigger>
      <TestReplayContent
        viewerUrl={viewerUrl}
        downloadHref={artifact.downloadHref}
        title={artifact.name}
        open={open}
        onClose={close}
      />
    </Dialog>
  );
}

/**
 * Per-row "Replay" button in the run's Tests-tab list. It only sets
 * `?replay=<testResultId>`; the modal itself is hosted once per page by
 * {@link ReplayModalHost}, so a row whose group later collapses (or a
 * hand-shared link) still resolves to the same modal. Rendered only for tests
 * known to have a trace (the row's `hasTrace`, set by the `…/results` read).
 */
export function ReplayRowButton({
  testResultId,
}: {
  testResultId: string;
}): React.ReactElement {
  const [, setReplay] = useSearchParam(REPLAY_PARAM, "");
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-primary"
      onClick={(e) => {
        // The row is a <Link>; don't navigate when opening the replay.
        e.preventDefault();
        e.stopPropagation();
        setReplay(testResultId);
      }}
      // Register-only warm: this row doesn't know its trace URL (only the
      // replay endpoint, fetched lazily by `ReplayModalHost`, does), but the
      // SW registration alone shaves the modal's first-ever load.
      onPointerEnter={() => warmTraceViewer()}
    >
      <PlayCircle className="size-3.5" strokeWidth={2} />
      Replay
    </Button>
  );
}

/**
 * Page-level host for the Tests-tab Replay modal. Mounted once by
 * `RunProgress`, it watches `?replay=<testResultId>` and lazily mints the
 * viewer URL from the replay endpoint (the list carries no artifact rows).
 * Hosting it here — rather than inside each row — means a deep-link opens the
 * modal even when the target test's group isn't expanded, and the modal
 * survives row re-fetches / collapses. A missing trace (404) or transient
 * failure clears the param so the URL never lies.
 */
export function ReplayModalHost({
  teamSlug,
  projectSlug,
  runId,
}: {
  teamSlug: string;
  projectSlug: string;
  runId: string;
}): React.ReactElement {
  const [replay, setReplay] = useSearchParam(REPLAY_PARAM, "");

  const query = useQuery({
    queryKey: ["test-replay", teamSlug, projectSlug, runId, replay],
    queryFn: ({ signal }) =>
      // Typed client: returns `TestReplayResponse`, so a contract change would
      // break this at compile time.
      fetch(
        "/api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/replay",
        {
          params: { teamSlug, projectSlug, runId, testResultId: replay },
          signal,
        },
      ),
    enabled: replay !== "",
    // A trace for a given testResultId is immutable — never refetch on remount.
    staleTime: Number.POSITIVE_INFINITY,
  });

  // No trace / transient failure — drop the param so the URL doesn't advertise
  // a modal that can't open. This is a navigation side effect, so it can't run
  // during render.
  useEffect(() => {
    if (query.isError) setReplay("");
  }, [query.isError, setReplay]);

  const close = (): void => setReplay("");
  const resolved = query.data;
  const open = Boolean(replay) && resolved !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {resolved ? (
        <TestReplayContent
          viewerUrl={resolved.traceViewerUrl}
          downloadHref={resolved.downloadHref}
          title={resolved.title}
          attempts={resolved.attempts.map((a) => ({
            attempt: a.attempt,
            viewerUrl: a.traceViewerUrl,
            downloadHref: a.downloadHref,
          }))}
          open={open}
          onClose={close}
        />
      ) : null}
    </Dialog>
  );
}
