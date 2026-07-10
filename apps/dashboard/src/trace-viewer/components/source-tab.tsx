"use client";

import { useEffect, useRef, useState } from "react";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import type { TraceTabProps } from "../model";
import { sha1Path } from "../model";
import type { StackFrame } from "../vendor/protocol-types";

/**
 * Playwright's own viewer resolves a stack frame's `file` to a trace resource
 * at `sha1/src@<sha1>.txt` where `<sha1>` is the SHA-1 (lower hex) of the RAW
 * `file` string itself — no path normalization. Verified against
 * microsoft/playwright tag v1.61.1,
 * packages/trace-viewer/src/ui/sourceTab.tsx (`calculateSha1` + its call site
 * in `useSources`), and empirically: sha1 of
 * "/tmp/pw-trace-test/tests/probe2.spec.ts" (the spec path recorded in that
 * trace's `0-trace.stacks`) equals `bf45fd7c3d5318ab34731eab199ac8d9f8c4a271`,
 * the exact resource file the trace shipped as `src@....txt`.
 */
async function sha1Hex(text: string): Promise<string> {
  const buffer = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Default file: the selected frame's file, else the first file carrying an
 * error, else whichever file the model saw first. */
function pickDefaultFile(
  frame: StackFrame | undefined,
  sources: TraceTabProps["model"]["sources"],
): string | undefined {
  if (frame && sources.has(frame.file)) return frame.file;
  for (const [file, source] of sources) {
    if (source.errors.length > 0) return file;
  }
  return sources.keys().next().value;
}

/**
 * Read-only source view for the selected action's stack frame, with a stack
 * frame picker alongside it.
 */
export function SourceTab(props: TraceTabProps): React.ReactElement {
  const { model, selectedAction, traceUrl, bridge } = props;
  const files = Array.from(model.sources.keys());
  const [manualFile, setManualFile] = useState<string | undefined>(undefined);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);

  useEffect(() => {
    setManualFile(undefined);
    setSelectedFrameIndex(0);
  }, [selectedAction?.callId]);

  const stack = selectedAction?.stack ?? [];
  const selectedFrame = stack[selectedFrameIndex];

  const file = manualFile ?? pickDefaultFile(selectedFrame, model.sources);
  const source = file ? model.sources.get(file) : undefined;

  const [content, setContent] = useState<string | undefined>(source?.content);
  const [fetchError, setFetchError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setFetchError(undefined);
    if (!file || !source) {
      setContent(undefined);
      return;
    }
    if (source.content !== undefined) {
      setContent(source.content);
      return;
    }
    setContent(undefined);
    let cancelled = false;
    void (async () => {
      try {
        const sha1 = await sha1Hex(file);
        const blob = await bridge.fetchBlob(
          sha1Path(traceUrl, `src@${sha1}.txt`),
        );
        const text = await blob.text();
        if (cancelled) return;
        // Cache on the shared model, mirroring the upstream viewer's own
        // lazy-fill of `SourceModel.content` — later tab visits (and other
        // consumers of this `model`) skip the fetch.
        source.content = text;
        setContent(text);
      } catch (err) {
        if (cancelled) return;
        setFetchError(
          err instanceof Error ? err.message : "Failed to load source.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, source, traceUrl, bridge]);

  if (files.length === 0 || !file) {
    return (
      <div className="px-3 py-4 text-12 text-fg-4">
        Source view is not available yet.
      </div>
    );
  }

  const targetLine =
    selectedFrame && selectedFrame.file === file
      ? selectedFrame.line
      : source?.errors[0]?.line;
  const errors = source?.errors ?? [];

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {files.length > 1 ? (
          <TabBar className="shrink-0 px-2" role="tablist" scrollable>
            {files.map((f) => (
              <span key={f} title={f}>
                <TabBarTab
                  active={f === file}
                  onSelect={() => setManualFile(f)}
                >
                  {basename(f)}
                </TabBarTab>
              </span>
            ))}
          </TabBar>
        ) : (
          <div
            className="shrink-0 truncate border-b border-line-1 px-3 py-1.5 text-12 text-fg-3"
            title={file}
          >
            {basename(file)}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {fetchError ? (
            <div className="px-3 py-2 text-12 text-fg-4">{fetchError}</div>
          ) : content === undefined ? null : (
            <SourceLines
              content={content}
              errors={errors}
              targetLine={targetLine}
            />
          )}
        </div>
      </div>
      {stack.length > 0 ? (
        <FrameList
          frames={stack}
          onSelect={(index) => {
            setSelectedFrameIndex(index);
            setManualFile(undefined);
          }}
          selectedIndex={selectedFrameIndex}
          sources={model.sources}
        />
      ) : null}
    </div>
  );
}

/**
 * Right-hand stack frame picker (~35% width, own scroll region). Clicking an
 * enabled frame switches the displayed file to that frame's file and
 * scroll-highlights its line (via `targetLine` in the parent, which is driven
 * by the selected frame). Frames whose file never made it into
 * `model.sources` (e.g. library-internal frames the trace didn't capture
 * source for) render disabled.
 */
function FrameList({
  frames,
  selectedIndex,
  sources,
  onSelect,
}: {
  frames: StackFrame[];
  selectedIndex: number;
  sources: TraceTabProps["model"]["sources"];
  onSelect: (index: number) => void;
}): React.ReactElement {
  return (
    <div
      className="w-[35%] min-w-[160px] shrink-0 overflow-y-auto border-l border-line-1"
      role="list"
    >
      {frames.map((frame, index) => {
        const available = sources.has(frame.file);
        const active = index === selectedIndex;
        return (
          <button
            className={cn(
              "flex w-full flex-col items-start gap-0.5 border-b border-line-1 px-3 py-1.5 text-left",
              available ? "cursor-pointer hover:bg-bg-2" : "cursor-default",
              active && available && "bg-bg-2",
            )}
            disabled={!available}
            key={`${frame.file}:${frame.line}:${index}`}
            onClick={() => onSelect(index)}
            title={frame.file}
            type="button"
          >
            <span
              className={cn(
                "truncate text-12",
                available ? "text-fg-3" : "text-fg-4",
              )}
            >
              {frame.function || "(anonymous)"}
            </span>
            <span
              className={cn(
                "truncate font-mono text-12",
                available ? "text-fg-2" : "text-fg-4",
              )}
            >
              {basename(frame.file)}:{frame.line}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Line-numbered `<pre>` renderer: target line highlighted + scrolled into
 * view, error lines tinted with their message inline beneath. A CodeMirror
 * (syntax-highlighted) variant was attempted and REVERTED: custom
 * decoration extensions built outside the wrapper hit "multiple instances
 * of @codemirror/state" under Vite dev pre-bundling (instanceof breakage),
 * silently falling back anyway. Revisit only with a vite dedupe fix.
 */
function SourceLines({
  content,
  errors,
  targetLine,
}: {
  content: string;
  errors: { line: number; message: string }[];
  targetLine: number | undefined;
}): React.ReactElement {
  const lines = content.split("\n");
  const errorsByLine = new Map<number, string>();
  for (const error of errors) errorsByLine.set(error.line, error.message);
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [targetLine, content]);

  return (
    <pre className="min-w-max py-1 font-mono text-13 leading-5">
      {lines.map((line, i) => {
        const lineNumber = i + 1;
        const isTarget = lineNumber === targetLine;
        const errorMessage = errorsByLine.get(lineNumber);
        return (
          <div key={lineNumber}>
            <div
              className={cn(
                "flex gap-3 px-3",
                isTarget && "bg-bg-2",
                errorMessage && "bg-fail-soft",
              )}
              ref={isTarget ? targetRef : undefined}
            >
              <span className="w-8 shrink-0 select-none text-right tabular-nums text-fg-4">
                {lineNumber}
              </span>
              <span className="whitespace-pre">{line || " "}</span>
            </div>
            {errorMessage ? (
              <div className="ml-11 whitespace-pre-wrap break-words px-3 py-1 text-12 text-fail">
                {errorMessage}
              </div>
            ) : null}
          </div>
        );
      })}
    </pre>
  );
}
