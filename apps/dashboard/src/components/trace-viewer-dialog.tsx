"use client";

import { Download, ExternalLink, PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetch } from "void/client";
import type { ArtifactAction } from "@/components/artifact-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSearchParam } from "@/lib/use-search-param";

/**
 * URL param that drives the Replay modal so it's deep-linkable / shareable.
 * On the run's Tests tab the value is a `testResultId` (the modal is hosted
 * once by {@link ReplayModalHost}, which mints the viewer URL on demand); on
 * the test-detail artifacts rail it's an `artifactId` (the URL is already known
 * at SSR — see {@link TraceViewerDialog}). Closing clears it (the param drops
 * out of the URL entirely — see `useSearchParam`).
 */
const REPLAY_PARAM = "replay";

/**
 * Shared body of the Replay dialog: a near-full-viewport panel whose iframe
 * hosts the self-hosted Playwright trace viewer
 * (`/trace-viewer/index.html?trace=…`, vendored into `public/` — see
 * `scripts/vendor-trace-viewer.mjs`). This gives Cypress-style time-travel (DOM
 * snapshot scrubber + command log + network + console) without leaving the
 * dashboard, and without the trace bytes ever reaching the public
 * trace.playwright.dev.
 *
 * The iframe mounts only while `open` so the ~1.6 MB bundle + service-worker
 * registration defer to first use and a reopened dialog reloads fresh (no stale
 * snapshot from a prior trace).
 */
function TestReplayContent({
  viewerUrl,
  downloadHref,
  title,
  open,
  onClose,
}: {
  viewerUrl: string;
  downloadHref: string;
  title: string;
  open: boolean;
  /** Close the modal (clears the `?replay=` URL param). */
  onClose: () => void;
}): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // The viewer URL embeds the absolute signed download URL after `?trace=`.
  // Reuse it verbatim for the public-viewer fallback so both point at the exact
  // same artifact (the download endpoint already CORS-allows that origin).
  const encodedTrace = viewerUrl.split("?trace=")[1] ?? "";
  const publicViewerUrl = encodedTrace
    ? `https://trace.playwright.dev/?trace=${encodedTrace}`
    : null;

  return (
    <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-1 py-2.5 pr-12 pl-4">
        <DialogTitle className="min-w-0 truncate text-sm font-medium">
          {title}
        </DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            render={<a href={viewerUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
            New tab
          </Button>
          <Button
            size="sm"
            variant="ghost"
            render={<a href={downloadHref} download />}
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
      {open ? (
        <iframe
          ref={iframeRef}
          title={`Replay: ${title}`}
          src={viewerUrl}
          className="min-h-0 w-full flex-1 border-0 bg-bg-0"
          // The viewer is self-hosted (same-origin), so a keydown inside the
          // iframe never bubbles to the parent Dialog — Escape would otherwise
          // be swallowed while focus is in the viewer. Bind Escape on the
          // iframe's own window so it still closes the modal (the Dialog's own
          // handler covers the case where focus is on the header controls).
          onLoad={() => {
            try {
              iframeRef.current?.contentWindow?.addEventListener(
                "keydown",
                (e) => {
                  if (e.key === "Escape") onClose();
                },
              );
            } catch {
              // Cross-origin content window (shouldn't happen for the vendored
              // viewer) — nothing to bind; the header + backdrop still close it.
            }
          }}
        />
      ) : null}
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
}: {
  artifact: ArtifactAction;
  children: React.ReactNode;
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
  const [resolved, setResolved] = useState<{
    testResultId: string;
    viewerUrl: string;
    downloadHref: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    if (!replay) {
      setResolved(null);
      return;
    }
    if (resolved?.testResultId === replay) return;
    let cancelled = false;
    void (async () => {
      try {
        // Typed client: returns `TestReplayResponse`, so a contract change would
        // break this at compile time.
        const body = await fetch(
          "/api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/replay",
          { params: { teamSlug, projectSlug, runId, testResultId: replay } },
        );
        if (!cancelled) {
          setResolved({
            testResultId: replay,
            viewerUrl: body.traceViewerUrl,
            downloadHref: body.downloadHref,
            title: body.title,
          });
        }
      } catch {
        // No trace / transient failure — drop the param so the URL doesn't
        // advertise a modal that can't open.
        if (!cancelled) setReplay("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replay, resolved?.testResultId, teamSlug, projectSlug, runId, setReplay]);

  const close = (): void => setReplay("");
  const open = Boolean(replay) && resolved?.testResultId === replay;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {resolved && resolved.testResultId === replay ? (
        <TestReplayContent
          viewerUrl={resolved.viewerUrl}
          downloadHref={resolved.downloadHref}
          title={resolved.title}
          open={open}
          onClose={close}
        />
      ) : null}
    </Dialog>
  );
}
