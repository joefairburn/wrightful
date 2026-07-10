"use client";

import { Download, Paperclip } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { sha1DownloadUrl } from "../model";
import type { TraceTabProps } from "../model";

/** Visible test attachments, downloadable via the SW sha1 route or inline base64. */
export function AttachmentsTab({
  model,
  traceUrl,
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
          return (
            <div key={i} className="flex items-center gap-2.5 px-3 py-2">
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
