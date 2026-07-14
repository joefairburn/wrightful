"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { defaultSelectedActionId, describeTraceLoadError } from "../model";
import type { TraceBridge } from "../use-trace-model";
import { useTraceModel } from "../use-trace-model";
import type { ContextEntry } from "../vendor/entries";
import { TraceModel } from "../vendor/model-util";
import { ActionList } from "./action-list";
import { DetailTabs } from "./detail-tabs";
import { usePlayback } from "./playback-controls";
import { SnapshotPane } from "./snapshot-pane";
import { SplitPane } from "./split-pane";
import { Timeline } from "./timeline";

/**
 * Wrightful's own Playwright trace viewer ("Replay"). Loads the trace model
 * through the vendored Playwright service worker (see `../bridge.html` /
 * `../use-trace-model.ts`) and renders the workbench with the dashboard's
 * component library — replacing the old iframe embed of the official viewer
 * UI. `traceUrl` must be absolute (typically the signed artifact download
 * URL resolved against the current origin).
 *
 * When `traceUrl` changes while a model is showing (attempt switch), the
 * hook keeps the previous model alive and loads the new trace behind it —
 * the workbench stays MOUNTED (deliberately un-keyed; it resets its own
 * selection when the model swaps) with only a thin progress bar on top.
 * Keeping the same workbench instance is what lets the snapshot pane
 * double-buffer across the swap instead of tearing its iframes down.
 */
export function TraceViewer({
  traceUrl,
  onEscape,
}: {
  traceUrl: string;
  onEscape?: () => void;
}): React.ReactElement {
  const { state, bridge } = useTraceModel(traceUrl);

  if (state.status === "loading") {
    const { progress } = state;
    const fraction =
      progress && progress.total > 0 ? progress.done / progress.total : null;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="size-5 text-fg-3" />
        <div className="text-body text-fg-3">Loading trace…</div>
        {fraction !== null ? (
          <div
            role="progressbar"
            aria-label="Loading trace"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="h-1 w-48 overflow-hidden rounded-full bg-bg-3"
          >
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

  const switchProgress = state.switching?.progress ?? null;
  const switchFraction =
    switchProgress && switchProgress.total > 0
      ? switchProgress.done / switchProgress.total
      : null;

  return (
    <div aria-busy={state.switching !== null} className="relative h-full">
      {state.switching ? (
        <div
          role="progressbar"
          aria-label="Loading attempt"
          aria-valuemin={0}
          aria-valuemax={100}
          // Indeterminate (no aria-valuenow) until the SW reports progress.
          aria-valuenow={
            switchFraction !== null
              ? Math.round(switchFraction * 100)
              : undefined
          }
          className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-bg-3"
        >
          <div
            className={
              switchFraction !== null
                ? "h-full bg-ring transition-[width]"
                : "h-full w-full animate-pulse bg-ring"
            }
            style={
              switchFraction !== null
                ? { width: `${Math.round(switchFraction * 100)}%` }
                : undefined
            }
          />
        </div>
      ) : null}
      <Workbench
        traceUrl={state.traceUrl}
        contextEntries={state.contextEntries}
        bridge={bridge}
        onEscape={onEscape}
      />
    </div>
  );
}

function Workbench({
  traceUrl,
  contextEntries,
  bridge,
  onEscape,
}: {
  traceUrl: string;
  contextEntries: ContextEntry[];
  bridge: TraceBridge;
  onEscape?: () => void;
}): React.ReactElement {
  const model = useMemo(
    () => new TraceModel(traceUrl, contextEntries),
    [traceUrl, contextEntries],
  );
  // Selection is stored WITH the model it belongs to. The workbench stays
  // mounted across an attempt swap (see TraceViewer), so when a new model
  // arrives the stale callId is replaced during render — an effect-based
  // reset would let one frame render the old selection against the new
  // model, flashing the snapshot pane's empty state.
  const [selection, setSelection] = useState<{
    model: TraceModel;
    callId: string | undefined;
  }>(() => ({ model, callId: defaultSelectedActionId(model) }));
  if (selection.model !== model) {
    setSelection({ model, callId: defaultSelectedActionId(model) });
  }
  const selectedCallId =
    selection.model === model
      ? selection.callId
      : defaultSelectedActionId(model);
  const setSelectedCallId = (callId: string | undefined): void =>
    setSelection({ model, callId });
  const selectedAction = useMemo(
    () => model.actions.find((a) => a.callId === selectedCallId),
    [model, selectedCallId],
  );

  // Hover preview for the snapshot canvas only — DetailTabs/Timeline/playback
  // all key off `selectedCallId` and are untouched by hovering. Stored WITH
  // the model it belongs to, same render-time reset as `selection` above, so
  // a stale hover from the previous attempt can never render against the new
  // model for even one frame.
  const [hover, setHover] = useState<{
    model: TraceModel;
    callId: string | undefined;
  }>(() => ({ model, callId: undefined }));
  if (hover.model !== model) {
    setHover({ model, callId: undefined });
  }
  const hoveredCallId = hover.model === model ? hover.callId : undefined;
  const setHoveredCallId = (callId: string | undefined): void =>
    setHover({ model, callId });
  const hoveredAction = useMemo(
    () => model.actions.find((a) => a.callId === hoveredCallId),
    [model, hoveredCallId],
  );
  // Coalesced once and shared by the snapshot pane and the Source tab — the
  // only two panels that follow hover (upstream viewer parity); every other
  // detail tab keys off `selectedAction` alone.
  const activeAction = hoveredAction ?? selectedAction;

  // Playback (rAF clock + prev/play/stop/next/speed state) lives here, one
  // level above both the timeline strip (which draws the moving Playhead) and
  // the snapshot pane's nav (which renders the control cluster) — the two are
  // siblings, so a single shared controller is what keeps the Playhead and the
  // buttons in lockstep. Prev/next stepping and click-to-seek walk the
  // DEFAULT-VISIBLE action set (`filteredActions([])` drops the route/getter/
  // configuration noise groups the action list hides by default) — selecting a
  // hidden action would land on a row that isn't in the list, so "Next" would
  // appear to do nothing.
  const playableActions = useMemo(() => model.filteredActions([]), [model]);
  const playback = usePlayback({
    traceStartTime: model.startTime,
    playableActions,
    selectedCallId,
    selectedStartTime: selectedAction?.startTime,
    onSelect: setSelectedCallId,
  });

  // An attempt swap replaces `model` in place (the workbench stays mounted, see
  // TraceViewer). The playhead's clock lives in the previous trace's time base,
  // so playback that survives the swap would run from a stale, out-of-range
  // position — stop it instead of letting it dead-play or instantly complete.
  const { pause } = playback;
  const playbackModelRef = useRef(model);
  useEffect(() => {
    if (playbackModelRef.current === model) return;
    playbackModelRef.current = model;
    pause();
  }, [model, pause]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Timeline
        model={model}
        bridge={bridge}
        selectedCallId={selectedCallId}
        onSelect={setSelectedCallId}
        playback={playback}
        playableActions={playableActions}
        className="shrink-0 border-b border-line-1"
      />
      <SplitPane
        direction="horizontal"
        initial={0.32}
        min={0.18}
        max={0.55}
        className="min-h-0 flex-1"
      >
        <ActionList
          model={model}
          selectedCallId={selectedCallId}
          onSelect={setSelectedCallId}
          onHover={setHoveredCallId}
        />
        <SplitPane
          direction="vertical"
          initial={0.62}
          min={0.3}
          max={0.85}
          className="h-full"
        >
          <SnapshotPane
            action={activeAction}
            traceUrl={traceUrl}
            bridge={bridge}
            onEscape={onEscape}
            playback={playback}
            playableActionsCount={playableActions.length}
          />
          <DetailTabs
            model={model}
            selectedAction={selectedAction}
            activeAction={activeAction}
            onSelectAction={setSelectedCallId}
            traceUrl={traceUrl}
            bridge={bridge}
          />
        </SplitPane>
      </SplitPane>
    </div>
  );
}
