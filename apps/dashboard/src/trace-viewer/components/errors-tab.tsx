"use client";

import type React from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ansiToHtml } from "@/lib/ansi";
import { actionTitle } from "../model";
import type { TraceTabProps } from "../model";

/** Test/action errors, each optionally jumping the action list to its source. */
export function ErrorsTab({
  model,
  onSelectAction,
}: TraceTabProps): React.ReactElement {
  const errors = model.errorDescriptors;

  if (errors.length === 0) {
    return (
      <Empty className="h-full py-8">
        <EmptyTitle>No errors</EmptyTitle>
        <EmptyDescription>This trace recorded no errors.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col divide-y divide-line-1">
        {errors.map((descriptor, i) => {
          const action = descriptor.action;
          return (
            <div key={i} className="flex flex-col gap-1.5 px-3 py-2.5">
              {action ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="w-fit"
                  onClick={() => onSelectAction(action.callId)}
                >
                  {actionTitle(action)}
                </Button>
              ) : null}
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: ansiToHtml HTML-escapes before colourising */}
              <pre
                className="whitespace-pre-wrap break-words font-mono text-12"
                dangerouslySetInnerHTML={{
                  __html: ansiToHtml(descriptor.message),
                }}
              />
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
