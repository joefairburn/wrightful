"use client";

import { Clipboard } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ansiToHtml, stripAnsi } from "@/lib/ansi";
import { useCopiedFlag } from "@/lib/use-copied-flag";
import { actionTitle } from "../model";
import type { TraceTabProps } from "../model";
import type { ErrorDescription } from "../vendor/model-util";

/**
 * Plain-text LLM-debugging prompt for one error, matching the official
 * viewer's "Copy prompt" affordance (1.51+): the error message (ANSI
 * stripped — this goes to a clipboard, not a terminal), the failing action's
 * title, and the topmost stack frame, each omitted when absent.
 */
export function buildErrorPrompt(descriptor: ErrorDescription): string {
  const details: string[] = [];
  if (descriptor.action) {
    details.push(`Failing action: ${actionTitle(descriptor.action)}`);
  }
  const frame = descriptor.stack?.[0];
  if (frame) {
    details.push(`At: ${frame.file}:${frame.line}`);
  }

  const sections = [
    "My Playwright test failed.",
    `Error:\n${stripAnsi(descriptor.message)}`,
    ...(details.length > 0 ? [details.join("\n")] : []),
    "Suggest the likely cause and a fix.",
  ];
  return sections.join("\n\n");
}

/** "Copy prompt" button for one error block; flips to "Copied" via {@link useCopiedFlag}. */
function CopyPromptButton({
  descriptor,
}: {
  descriptor: ErrorDescription;
}): React.ReactElement {
  const { copied, flash } = useCopiedFlag();

  return (
    <Button
      variant="ghost"
      size="xs"
      className="w-fit"
      onClick={() => {
        navigator.clipboard
          .writeText(buildErrorPrompt(descriptor))
          .then(flash)
          .catch(() => {
            /* clipboard write failure — nothing to recover, just skip the flash */
          });
      }}
    >
      <Clipboard />
      {copied ? "Copied" : "Copy prompt"}
    </Button>
  );
}

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
              <div className="flex items-center gap-1.5">
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
                <CopyPromptButton descriptor={descriptor} />
              </div>
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
