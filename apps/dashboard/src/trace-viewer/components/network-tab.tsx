"use client";

import type React from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBytes } from "../format";
import type { TraceTabProps } from "../model";

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length
      ? (segments[segments.length - 1] ?? url)
      : parsed.pathname || url;
  } catch {
    return url;
  }
}

/** HAR entries as a dense request table, highlighting the selected action's window. */
export function NetworkTab({
  model,
  selectedAction,
  scopeToSelected,
}: TraceTabProps): React.ReactElement {
  const scoped = scopeToSelected && selectedAction != null;
  // Scoped: filter to the selected action's window. Unscoped: keep every
  // entry and merely highlight the ones in that window (today's behavior).
  const isWithinSelectedAction = (monotonicTime: number | undefined): boolean =>
    selectedAction != null &&
    monotonicTime != null &&
    monotonicTime >= selectedAction.startTime &&
    monotonicTime <= selectedAction.endTime;
  const entries = scoped
    ? model.resources.filter((entry) =>
        isWithinSelectedAction(entry._monotonicTime),
      )
    : model.resources;

  if (entries.length === 0) {
    if (scoped) {
      return (
        <div className="px-3 py-4 text-12 text-fg-4">
          No requests during this action.
        </div>
      );
    }
    return (
      <Empty className="h-full py-8">
        <EmptyTitle>No network activity</EmptyTitle>
        <EmptyDescription>
          This trace recorded no network requests.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <ScrollArea className="h-full">
      <Table stickyHeader>
        <TableHeader className="sticky top-0 z-10 bg-bg-0">
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            // Destructure-and-rename: `_monotonicTime` is the HAR extension
            // field name (vendor/har.ts); the underscore trips lint as a
            // direct member access.
            const { _monotonicTime: monotonicTime } = entry;
            const isHighlighted =
              !scoped && isWithinSelectedAction(monotonicTime);
            const size =
              entry.response.content.size >= 0
                ? entry.response.content.size
                : entry.response.bodySize;
            const mimeType = entry.response.content.mimeType.split(";")[0];
            return (
              <TableRow
                key={entry.id}
                className={cn(isHighlighted && "bg-bg-2")}
              >
                <TableCell
                  className={cn(
                    "font-mono",
                    entry.response.status >= 400 && "text-fail",
                  )}
                >
                  {entry.response.status || "—"}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {entry.request.method}
                </TableCell>
                <TableCell
                  className="max-w-[320px] truncate"
                  title={entry.request.url}
                >
                  {shortUrl(entry.request.url)}
                </TableCell>
                <TableCell className="text-fg-4">{mimeType || "—"}</TableCell>
                <TableCell className="font-mono text-fg-3">
                  {formatBytes(size)}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {Math.round(entry.time)}ms
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
