"use client";

import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  Paperclip,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { prettyPrintJson } from "../format";
import { sha1DownloadUrl, sha1Path } from "../model";
import type { TraceTabProps } from "../model";
import { useBridgeText } from "../use-bridge-fetch";
import { useObjectUrl } from "../use-object-url";
import type { TraceBridge } from "../use-trace-model";
import type { Attachment } from "../vendor/model-util";

/** Cap on the text preview's rendered length — huge logs shouldn't hang the tab. */
const TEXT_PREVIEW_MAX_CHARS = 50_000;

/**
 * Attachments we can render an inline text preview for: plain text or JSON,
 * with bytes actually reachable (sha1 via the SW bridge, or inline base64).
 */
function isTextPreviewable(attachment: Attachment): boolean {
  const isTextLike =
    attachment.contentType.startsWith("text/") ||
    attachment.contentType === "application/json";
  return isTextLike && Boolean(attachment.sha1 || attachment.base64);
}

/** Pretty-print JSON (best-effort) and cap the length before rendering. */
function formatPreviewText(raw: string, contentType: string): string {
  let text = prettyPrintJson(raw, contentType);
  if (text.length > TEXT_PREVIEW_MAX_CHARS) {
    text = `${text.slice(0, TEXT_PREVIEW_MAX_CHARS)}… truncated`;
  }
  return text;
}

/**
 * Attachments the inline lightbox can render full-size: images and videos
 * whose bytes are actually reachable (sha1 via the SW bridge, or inline
 * base64).
 */
function mediaKind(attachment: Attachment): "image" | "video" | null {
  if (!attachment.sha1 && !attachment.base64) return null;
  if (attachment.contentType.startsWith("image/")) return "image";
  if (attachment.contentType.startsWith("video/")) return "video";
  return null;
}

/**
 * Full-size media viewer — a dialog nested inside the trace-viewer dialog
 * (Base UI stacks them, so Escape/backdrop close only the lightbox). Bytes
 * resolve exactly like the thumbnail's: through the bridge for sha1
 * attachments (deferred until the dialog opens; the object URL is revoked on
 * close via the null path), or straight from inline base64. Rendering via
 * `<img>`/`<video>` is script-inert, so even an svg+xml attachment is safe
 * here — unlike a top-level `data:` navigation.
 */
function AttachmentLightbox({
  attachment,
  kind,
  bridge,
  traceUrl,
  open,
  onOpenChange,
}: {
  attachment: Attachment;
  kind: "image" | "video";
  bridge: TraceBridge;
  traceUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const path =
    open && !attachment.base64 && attachment.sha1
      ? sha1Path(traceUrl, attachment.sha1)
      : null;
  const { url: fetchedUrl, error } = useObjectUrl(bridge, path);
  const mediaUrl = attachment.base64
    ? `data:${attachment.contentType};base64,${attachment.base64}`
    : fetchedUrl;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogTitle className="min-w-0 truncate border-b border-line-1 py-2.5 pr-12 pl-4 font-medium text-body">
          {attachment.name}
        </DialogTitle>
        <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-b-2xl bg-bg-0">
          {error ? (
            <span className="text-body text-fg-3">
              Unable to load attachment.
            </span>
          ) : !mediaUrl ? (
            <Spinner />
          ) : kind === "video" ? (
            <video
              src={mediaUrl}
              controls
              autoPlay
              className="max-h-[80vh] w-full bg-black"
            >
              <track kind="captions" />
            </video>
          ) : (
            <img
              src={mediaUrl}
              alt={attachment.name}
              className="max-h-[80vh] w-full object-contain"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline thumbnail for an image attachment. An `<img src>` pointing straight
 * at the SW sha1 route would 404 from the dashboard origin — the SW only
 * answers fetches from its own controlled bridge client, not plain <img>
 * subresource requests from the host page — so sha1 bytes are proxied
 * through the bridge and rendered as an object URL. Base64 attachments
 * already carry their bytes inline and skip the fetch entirely. Clicking
 * opens the in-viewer lightbox.
 */
function AttachmentPreview({
  attachment,
  bridge,
  traceUrl,
  onView,
}: {
  attachment: Attachment;
  bridge: TraceBridge;
  traceUrl: string;
  onView: () => void;
}): React.ReactElement | null {
  const path = attachment.sha1 ? sha1Path(traceUrl, attachment.sha1) : null;
  const { url: fetchedUrl, error } = useObjectUrl(bridge, path);
  const previewUrl = attachment.base64
    ? `data:${attachment.contentType};base64,${attachment.base64}`
    : fetchedUrl;

  if (error) return null;

  if (!previewUrl) {
    return (
      <div className="h-16 w-16 shrink-0 rounded border border-line-1 bg-bg-2" />
    );
  }

  return (
    <button
      type="button"
      onClick={onView}
      title="View full size"
      className="shrink-0 cursor-pointer"
    >
      <img
        src={previewUrl}
        alt={attachment.name}
        className="max-h-24 rounded border border-line-1 object-contain"
      />
    </button>
  );
}

/**
 * One attachment row, incl. its optional text preview. Extracted from
 * `AttachmentsTab` so the expand/fetch state is a hook per ROW rather than
 * per tab — `useState`/`useEffect` can't be called conditionally inside a
 * `.map()`, but a child component invoked per item is exactly that.
 */
function AttachmentRow({
  attachment,
  bridge,
  traceUrl,
}: {
  attachment: Attachment;
  bridge: TraceBridge;
  traceUrl: string;
}): React.ReactElement {
  const href = attachment.sha1
    ? sha1DownloadUrl(
        traceUrl,
        attachment.sha1,
        attachment.name,
        attachment.contentType,
      )
    : attachment.base64
      ? `data:${attachment.contentType};base64,${attachment.base64}`
      : undefined;
  const kind = mediaKind(attachment);
  const textPreviewable = isTextPreviewable(attachment);

  const [expanded, setExpanded] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  // Base64 attachments carry their bytes inline — decoding is a pure,
  // synchronous derivation of the attachment itself, not something that
  // needs an effect (there's nothing async to bridge-fetch).
  const base64Text = useMemo<string | null>(() => {
    if (!textPreviewable || !attachment.base64) return null;
    try {
      // atob yields a Latin-1 byte-string; decode those bytes as UTF-8 so
      // non-ASCII content (accents, emoji, CJK) isn't rendered as mojibake.
      const bytes = Uint8Array.from(atob(attachment.base64), (c) =>
        c.charCodeAt(0),
      );
      const text = new TextDecoder().decode(bytes);
      return formatPreviewText(text, attachment.contentType);
    } catch {
      return "(unable to decode attachment)";
    }
  }, [textPreviewable, attachment]);

  // sha1-backed attachments need an actual fetch through the bridge — that's
  // the one genuinely async part, deferred until the row expands.
  const fetched = useBridgeText(
    bridge,
    expanded && textPreviewable && !attachment.base64 && attachment.sha1
      ? sha1Path(traceUrl, attachment.sha1)
      : null,
  );
  const formatted = useMemo(
    () =>
      fetched.text !== undefined
        ? formatPreviewText(fetched.text, attachment.contentType)
        : null,
    [fetched.text, attachment.contentType],
  );
  const fetchedText = fetched.error ? "(unable to load attachment)" : formatted;

  const text = base64Text ?? fetchedText;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-center gap-2.5">
        {textPreviewable ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-expanded={expanded}
            title={
              expanded ? "Collapse preview" : "Preview attachment contents"
            }
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ) : null}
        {kind === "image" ? (
          <AttachmentPreview
            attachment={attachment}
            bridge={bridge}
            traceUrl={traceUrl}
            onView={() => setViewerOpen(true)}
          />
        ) : null}
        <Paperclip className="size-3.5 shrink-0 text-fg-4" />
        <span className="min-w-0 flex-1 truncate text-body">
          {attachment.name}
        </span>
        <span className="shrink-0 text-fg-4 text-caption">
          {attachment.contentType}
        </span>
        {kind ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setViewerOpen(true)}
          >
            <Eye />
            View
          </Button>
        ) : null}
        {href ? (
          <Button
            size="xs"
            variant="outline"
            render={
              attachment.sha1 ? (
                <a href={href} target="_blank" rel="noreferrer" />
              ) : (
                <a href={href} download={attachment.name} />
              )
            }
          >
            <Download />
            Download
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">
          {text ?? "Loading…"}
        </pre>
      ) : null}
      {kind ? (
        <AttachmentLightbox
          attachment={attachment}
          kind={kind}
          bridge={bridge}
          traceUrl={traceUrl}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
        />
      ) : null}
    </div>
  );
}

/**
 * Visible test attachments. Images and videos open full-size in an in-viewer
 * lightbox, text/JSON expand inline, and everything with reachable bytes is
 * downloadable via the SW sha1 route or inline base64.
 */
export function AttachmentsTab({
  model,
  traceUrl,
  bridge,
}: TraceTabProps): React.ReactElement {
  const attachments = model.visibleAttachments;

  if (attachments.length === 0) {
    return (
      <Empty className="h-full py-8">
        <EmptyTitle>No attachments</EmptyTitle>
        <EmptyDescription>
          This trace has no visible attachments.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col divide-y divide-line-1">
        {attachments.map((attachment, i) => (
          <AttachmentRow
            key={i}
            attachment={attachment}
            bridge={bridge}
            traceUrl={traceUrl}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
