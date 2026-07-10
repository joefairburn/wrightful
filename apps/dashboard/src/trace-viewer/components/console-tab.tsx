"use client";

import { CircleAlert, TriangleAlert } from "lucide-react";
import type React from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { stripAnsi } from "@/lib/ansi";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import type { TraceTabProps } from "../model";
import { eventsForAction } from "../vendor/model-util";
import type {
  ConsoleMessageTraceEvent,
  EventTraceEvent,
} from "../vendor/trace";

type ConsoleRow = ConsoleMessageTraceEvent | EventTraceEvent;

function isConsoleRow(
  event: EventTraceEvent | ConsoleMessageTraceEvent,
): event is ConsoleRow {
  return (
    event.type === "console" ||
    (event.type === "event" && event.method === "pageError")
  );
}

function rowMessage(event: ConsoleRow): string {
  if (event.type === "console") return stripAnsi(event.text);
  const raw: unknown = event.params?.error?.error?.message;
  const message = typeof raw === "string" ? raw : "Uncaught (in promise)";
  return stripAnsi(message);
}

function rowLocation(event: ConsoleRow): string | undefined {
  if (event.type !== "console" || !event.location.url) return undefined;
  const last = event.location.url.split("/").pop() || event.location.url;
  return `${last}:${event.location.lineNumber}`;
}

function rowSeverity(event: ConsoleRow): "error" | "warning" | undefined {
  if (event.type === "event") return "error";
  if (event.messageType === "error") return "error";
  if (event.messageType === "warning") return "warning";
  return undefined;
}

/** Console messages + uncaught page errors, time-ordered, ANSI-stripped. */
export function ConsoleTab({
  model,
  selectedAction,
}: TraceTabProps): React.ReactElement {
  const rows = model.events.filter(isConsoleRow);
  const highlighted = selectedAction
    ? new Set(eventsForAction(selectedAction))
    : undefined;

  if (rows.length === 0) {
    return (
      <Empty className="h-full py-8">
        <EmptyTitle>No console output</EmptyTitle>
        <EmptyDescription>
          This trace recorded no console messages or page errors.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col divide-y divide-line-1">
        {rows.map((event, i) => {
          const severity = rowSeverity(event);
          const location = rowLocation(event);
          return (
            <div
              key={`${event.time}-${i}`}
              className={cn(
                "flex items-start gap-2 px-3 py-1.5 text-13 font-mono",
                highlighted?.has(event) && "bg-bg-2",
              )}
            >
              <span className="shrink-0 tabular-nums text-fg-4">
                {formatTraceOffset(event.time, model.startTime)}
              </span>
              {severity === "error" ? (
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-fail" />
              ) : null}
              {severity === "warning" ? (
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              ) : null}
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {rowMessage(event)}
              </span>
              {location ? (
                <span
                  className="max-w-[35%] shrink-0 truncate text-fg-4"
                  title={
                    event.type === "console" ? event.location.url : undefined
                  }
                >
                  {location}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
