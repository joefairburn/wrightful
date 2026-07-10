"use client";

import { Download, Paperclip } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { sha1DownloadUrl, sha1Path } from "../model";
import type { TraceTabProps } from "../model";
import { useObjectUrl } from "../use-object-url";
import type { TraceBridge } from "../use-trace-model";
import type { Attachment } from "../vendor/model-util";

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
        {attachments.map((attachment, i) => {
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
          return (
            <div key={i} className="flex items-center gap-2.5 px-3 py-2">
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
          );
        })}
      </div>
    </ScrollArea>
  );
}
