"use client";

import { useMemo, useState } from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { defaultSelectedActionId, describeTraceLoadError } from "../model";
import { useTraceModel } from "../use-trace-model";
import type { ContextEntry } from "../vendor/entries";
import { MultiTraceModel } from "../vendor/model-util";
import { ActionList } from "./action-list";
import { DetailTabs } from "./detail-tabs";
import { SnapshotPane } from "./snapshot-pane";
import { SplitPane } from "./split-pane";

/**
 * Wrightful's own Playwright trace viewer ("Replay"). Loads the trace model
 * through the vendored Playwright service worker (see `../bridge.html` /
 * `../use-trace-model.ts`) and renders the workbench with the dashboard's
 * component library — replacing the old iframe embed of the official viewer
 * UI. `traceUrl` must be absolute (typically the signed artifact download
 * URL resolved against the current origin).
 */
export function TraceViewer({
  traceUrl,
  onEscape,
}: {
  traceUrl: string;
  onEscape?: () => void;
}): React.ReactElement {
  const state = useTraceModel(traceUrl);

  if (state.status === "loading") {
    const { progress } = state;
    const fraction =
      progress && progress.total > 0 ? progress.done / progress.total : null;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="size-5 text-fg-3" />
        <div className="text-13 text-fg-3">Loading trace…</div>
        {fraction !== null ? (
          <div className="h-1 w-48 overflow-hidden rounded-full bg-bg-3">
            <div
              className="h-full rounded-full bg-ring transition-[width]"
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Empty className="h-full justify-center">
        <EmptyTitle>Couldn&apos;t load this trace</EmptyTitle>
        <EmptyDescription className="max-w-md whitespace-pre-wrap">
          {describeTraceLoadError(state.error)}
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <Workbench
      key={traceUrl}
      traceUrl={traceUrl}
      contextEntries={state.contextEntries}
      onEscape={onEscape}
    />
  );
}

function Workbench({
  traceUrl,
  contextEntries,
  onEscape,
}: {
  traceUrl: string;
  contextEntries: ContextEntry[];
  onEscape?: () => void;
}): React.ReactElement {
  const model = useMemo(
    () => new MultiTraceModel(traceUrl, contextEntries),
    [traceUrl, contextEntries],
  );
  const [selectedCallId, setSelectedCallId] = useState<string | undefined>(() =>
    defaultSelectedActionId(model),
  );
  const selectedAction = useMemo(
    () => model.actions.find((a) => a.callId === selectedCallId),
    [model, selectedCallId],
  );

  return (
    <SplitPane
      direction="horizontal"
      initial={0.32}
      min={0.18}
      max={0.55}
      className="h-full"
    >
      <ActionList
        model={model}
        selectedCallId={selectedCallId}
        onSelect={setSelectedCallId}
      />
      <SplitPane
        direction="vertical"
        initial={0.62}
        min={0.3}
        max={0.85}
        className="h-full"
      >
        <SnapshotPane
          action={selectedAction}
          traceUrl={traceUrl}
          onEscape={onEscape}
        />
        <DetailTabs
          model={model}
          selectedAction={selectedAction}
          onSelectAction={setSelectedCallId}
          traceUrl={traceUrl}
        />
      </SplitPane>
    </SplitPane>
  );
}
