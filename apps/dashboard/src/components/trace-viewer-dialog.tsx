"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, PlayCircle } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
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
 * Close-on-Escape across ALL of the trace viewer's same-origin frames. The
 * viewer is self-hosted (same-origin) and renders DOM snapshots in a NESTED
 * iframe; a keydown while focus is inside that snapshot frame reaches neither
 * the parent Dialog nor the top viewer window, so Escape would be swallowed
 * there. Bind the handler on the viewer window AND every reachable same-origin
 * descendant frame, re-binding as frames are added or re-navigated during a
 * scrub (each frame's `load` + a `MutationObserver` per document). Every access
 * is guarded — a cross-origin frame throws and is skipped, and any failure
 * degrades to the Dialog's own Escape/backdrop handling. Idempotent (WeakSets
 * guard re-binding); the returned cleanup tears everything down.
 */
function bindEscapeAcrossFrames(
  topWin: Window,
  onEscape: () => void,
): () => void {
  const cleanups: Array<() => void> = [];
  const boundWindows = new WeakSet<Window>();
  const boundFrames = new WeakSet<HTMLIFrameElement>();
  const observedDocs = new WeakSet<Document>();

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") onEscape();
  };

  function bindWindow(win: Window): void {
    if (boundWindows.has(win)) return;
    boundWindows.add(win);
    let doc: Document;
    try {
      win.addEventListener("keydown", onKey);
      doc = win.document;
    } catch {
      return; // cross-origin frame — unreachable, skip
    }
    cleanups.push(() => {
      try {
        win.removeEventListener("keydown", onKey);
      } catch {
        /* window already torn down */
      }
    });
    scanDoc(doc);
  }

  function scanDoc(doc: Document): void {
    for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
      if (boundFrames.has(frame)) continue;
      boundFrames.add(frame);
      const onFrameLoad = (): void => {
        const cw = frame.contentWindow;
        if (cw) bindWindow(cw);
      };
      frame.addEventListener("load", onFrameLoad);
      cleanups.push(() => frame.removeEventListener("load", onFrameLoad));
      onFrameLoad(); // bind whatever's currently loaded
    }
    if (observedDocs.has(doc)) return;
    observedDocs.add(doc);
    const observer = new MutationObserver(() => scanDoc(doc));
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  }

  bindWindow(topWin);
  return () => {
    for (const c of cleanups) c();
  };
}

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
  // Removes the iframe's Escape listener; set on each load, called on unmount.
  const escapeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => escapeCleanup.current?.(), []);

  // Public-viewer fallback — opens the trace on the public trace.playwright.dev
  // in a NEW TAB (never framed, so the page CSP doesn't apply). Built from the
  // explicit `downloadHref` prop + the current origin, NOT by parsing
  // `signedTraceViewerUrl`'s `?trace=` layout (which this component doesn't own).
  // Client-only (needs `window.location.origin`): null on SSR, set on hydrate.
  const publicViewerUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    const absoluteDownloadUrl = new URL(downloadHref, window.location.origin)
      .href;
    return `https://trace.playwright.dev/?trace=${encodeURIComponent(absoluteDownloadUrl)}`;
  }, [downloadHref]);

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
          // Bind Escape-to-close across the viewer's frames (see
          // `bindEscapeAcrossFrames`) — a same-origin iframe swallows the key
          // otherwise. Drop any prior binding first so a re-load can't stack
          // listeners; the unmount effect above clears the last one.
          onLoad={() => {
            escapeCleanup.current?.();
            const win = iframeRef.current?.contentWindow;
            escapeCleanup.current = win
              ? bindEscapeAcrossFrames(win, onClose)
              : null;
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
          open={open}
          onClose={close}
        />
      ) : null}
    </Dialog>
  );
}
