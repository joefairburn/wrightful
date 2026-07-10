"use client";

import type React from "react";
import { ansiToHtml } from "@/lib/ansi";
import { formatDuration } from "@/lib/time-format";
import { formatTraceOffset } from "../format";
import { actionTitle } from "../model";
import type { TraceTabProps } from "../model";

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-12 font-medium tracking-[0.1px] text-fg-3">
        {label}
      </dt>
      <dd className="font-mono text-12 text-fg-2">{value}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-12 font-medium tracking-[0.1px] text-fg-3">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Compact JSON preview: single-line for primitives, pretty + capped for objects. */
function renderJsonValue(value: unknown): React.ReactElement {
  const isObjectLike = typeof value === "object" && value !== null;
  if (!isObjectLike) {
    return (
      <span className="break-words font-mono text-12">
        {JSON.stringify(value)}
      </span>
    );
  }
  return (
    <pre className="max-h-40 overflow-auto break-words font-mono text-12">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function isNonEmptyResult(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** The "Call" detail tab: parameters, return value, timing and error for the selected action. */
export function CallTab({
  model,
  selectedAction,
}: TraceTabProps): React.ReactElement {
  if (!selectedAction) {
    return (
      <div className="px-3 py-4 text-12 text-fg-4">
        Select an action to see its call details.
      </div>
    );
  }

  const action = selectedAction;
  const params: Record<string, unknown> = action.params ?? {};
  const paramEntries = Object.entries(params);
  const hasResult = isNonEmptyResult(action.result);
  const errorMessage = action.error?.message;

  const wallClock =
    model.wallTime !== undefined
      ? new Date(
          model.wallTime + (action.startTime - model.startTime),
        ).toLocaleTimeString()
      : undefined;

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="flex flex-col gap-4 px-3 py-3">
        <div className="flex flex-col gap-3">
          <div className="font-mono text-13 font-medium text-fg-2">
            {actionTitle(action)}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5">
            <Field
              label="Start"
              value={
                wallClock
                  ? `${formatTraceOffset(action.startTime, model.startTime)} (${wallClock})`
                  : formatTraceOffset(action.startTime, model.startTime)
              }
            />
            <Field
              label="Duration"
              value={formatDuration(
                Math.max(0, Math.round(action.endTime - action.startTime)),
              )}
            />
            <Field label="Page" value={action.pageId ?? "—"} />
            <Field label="Call id" value={action.callId} />
          </dl>
        </div>

        {paramEntries.length > 0 ? (
          <Section title="Parameters">
            <dl className="flex flex-col gap-2">
              {paramEntries.map(([key, value]) => (
                <div key={key} className="flex flex-col gap-0.5">
                  <dt className="text-12 font-medium tracking-[0.1px] text-fg-3">
                    {key}
                  </dt>
                  <dd>{renderJsonValue(value)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}

        {hasResult ? (
          <Section title="Return value">
            <pre className="max-h-40 overflow-auto break-words font-mono text-12">
              {JSON.stringify(action.result, null, 2)}
            </pre>
          </Section>
        ) : null}

        {errorMessage ? (
          <Section title="Error">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: ansiToHtml HTML-escapes before colourising */}
            <pre
              className="whitespace-pre-wrap break-words font-mono text-12"
              dangerouslySetInnerHTML={{
                __html: ansiToHtml(errorMessage),
              }}
            />
          </Section>
        ) : null}
      </div>
    </div>
  );
}
