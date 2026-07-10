"use client";

import { ChevronDown, ChevronRight, Download, Paperclip } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { sha1DownloadUrl, sha1Path } from "../model";
import type { TraceTabProps } from "../model";
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
  let text = raw;
  if (contentType === "application/json") {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* not valid JSON despite the content-type — show the raw text */
    }
  }
  if (text.length > TEXT_PREVIEW_MAX_CHARS) {
    text = `${text.slice(0, TEXT_PREVIEW_MAX_CHARS)}… truncated`;
  }
  return text;
}

/**
 * Inline thumbnail for an image attachment. An `<img src>` pointing straight
 * at the SW sha1 route would 404 from the dashboard origin — the SW only
 * answers fetches from its own controlled bridge client, not plain <img>
 * subresource requests from the host page — so sha1 bytes are proxied
 * through the bridge and rendered as an object URL. Base64 attachments
 * already carry their bytes inline and skip the fetch entirely.
 */
function AttachmentPreview({
  attachment,
  bridge,
  traceUrl,
  href,
}: {
  attachment: Attachment;
  bridge: TraceBridge;
  traceUrl: string;
  href: string;
}): React.ReactElement {
  const path = attachment.sha1 ? sha1Path(traceUrl, attachment.sha1) : null;
  const { url: fetchedUrl, error } = useObjectUrl(bridge, path);
  const previewUrl = attachment.base64
    ? `data:${attachment.contentType};base64,${attachment.base64}`
    : fetchedUrl;

  if (error) return <></>;

  if (!previewUrl) {
    return (
      <div className="h-16 w-16 shrink-0 rounded border border-line-1 bg-bg-2" />
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" className="shrink-0">
      <img
        src={previewUrl}
        alt={attachment.name}
        className="max-h-24 rounded border border-line-1 object-contain"
      />
    </a>
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
  const isImage = attachment.contentType.startsWith("image/");
  const textPreviewable = isTextPreviewable(attachment);

  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || text !== null || !textPreviewable) return;
    if (attachment.base64) {
      try {
        setText(
          formatPreviewText(atob(attachment.base64), attachment.contentType),
        );
      } catch {
        setText("(unable to decode attachment)");
      }
      return;
    }
    if (!attachment.sha1) return;
    let cancelled = false;
    bridge
      .fetchBlob(sha1Path(traceUrl, attachment.sha1))
      .then((blob) => blob.text())
      .then((raw) => {
        if (!cancelled) setText(formatPreviewText(raw, attachment.contentType));
      })
      .catch(() => {
        if (!cancelled) setText("(unable to load attachment)");
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, text, textPreviewable, attachment, bridge, traceUrl]);

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
        {isImage && href ? (
          <AttachmentPreview
            attachment={attachment}
            bridge={bridge}
            traceUrl={traceUrl}
            href={href}
          />
        ) : null}
        <Paperclip className="size-3.5 shrink-0 text-fg-4" />
        <span className="min-w-0 flex-1 truncate text-13">
          {attachment.name}
        </span>
        <span className="shrink-0 text-fg-4 text-12">
          {attachment.contentType}
        </span>
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
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-12">
          {text ?? "Loading…"}
        </pre>
      ) : null}
    </div>
  );
}

/** Visible test attachments, downloadable via the SW sha1 route or inline base64. */
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
