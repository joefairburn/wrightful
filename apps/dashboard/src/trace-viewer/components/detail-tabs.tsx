"use client";

import { useEffect, useState } from "react";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { formatDuration } from "@/lib/time-format";
import type { TraceTabProps } from "../model";
import { AttachmentsTab } from "./attachments-tab";
import { ConsoleTab } from "./console-tab";
import { ErrorsTab } from "./errors-tab";
import { MetadataTab } from "./metadata-tab";
import { NetworkTab } from "./network-tab";

type DetailTabId =
  | "log"
  | "errors"
  | "console"
  | "network"
  | "attachments"
  | "metadata";

/**
 * Bottom pane: cross-cutting trace details. Counts on the tab labels are
 * whole-trace; the Log tab is scoped to the selected action.
 */
export function DetailTabs(props: TraceTabProps): React.ReactElement {
  const { model, selectedAction } = props;
  const errorCount = model.errorDescriptors.length;
  const consoleCount = model.events.filter(
    (e) =>
      e.type === "console" || (e.type === "event" && e.method === "pageError"),
  ).length;
  const [tab, setTab] = useState<DetailTabId>(
    errorCount > 0 ? "errors" : "log",
  );
  // A new trace (model identity change) re-evaluates the default.
  useEffect(() => {
    setTab(model.errorDescriptors.length > 0 ? "errors" : "log");
  }, [model]);

  const tabs: Array<{ id: DetailTabId; label: string; count?: number }> = [
    { id: "log", label: "Log" },
    { id: "errors", label: "Errors", count: errorCount },
    { id: "console", label: "Console", count: consoleCount },
    { id: "network", label: "Network", count: model.resources.length },
    {
      id: "attachments",
      label: "Attachments",
      count: model.visibleAttachments.length,
    },
    { id: "metadata", label: "Metadata" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabBar className="shrink-0 px-2" role="tablist">
        {tabs.map(({ id, label, count }) => (
          <TabBarTab key={id} active={tab === id} onSelect={() => setTab(id)}>
            {label}
            {count ? (
              <span className="ml-1 text-11 text-fg-4 tabular-nums">
                {count}
              </span>
            ) : null}
          </TabBarTab>
        ))}
      </TabBar>
      <div className="min-h-0 flex-1">
        {tab === "log" ? (
          <LogTab selectedAction={selectedAction} startTime={model.startTime} />
        ) : null}
        {tab === "errors" ? <ErrorsTab {...props} /> : null}
        {tab === "console" ? <ConsoleTab {...props} /> : null}
        {tab === "network" ? <NetworkTab {...props} /> : null}
        {tab === "attachments" ? <AttachmentsTab {...props} /> : null}
        {tab === "metadata" ? <MetadataTab {...props} /> : null}
      </div>
    </div>
  );
}

function LogTab({
  selectedAction,
  startTime,
}: {
  selectedAction: TraceTabProps["selectedAction"];
  startTime: number;
}): React.ReactElement {
  const log = selectedAction?.log ?? [];
  if (log.length === 0) {
    return (
      <div className="px-3 py-4 text-12 text-fg-4">
        {selectedAction
          ? "No log entries for this action."
          : "Select an action to see its log."}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto overscroll-contain py-1">
      {log.map((entry, i) => (
        <div
          key={i}
          className="flex items-baseline gap-2 px-3 py-0.5 font-mono text-12"
        >
          <span className="shrink-0 text-fg-4 tabular-nums">
            {formatDuration(Math.max(0, Math.round(entry.time - startTime)))}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-fg-2">
            {entry.message}
          </span>
        </div>
      ))}
    </div>
  );
}
