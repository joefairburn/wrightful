"use client";

import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { useEffect, useMemo, useRef, useState } from "react";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import type { TraceTabProps } from "../model";
import { isRealSourceFile, sha1Path } from "../model";
import { useBridgeFetch } from "../use-bridge-fetch";
import type { StackFrame } from "../vendor/protocol-types";
import { TabNotice } from "./detail-shared";

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
 * error, else whichever file the model saw first. Never picks a synthetic
 * (non-real) file — e.g. Playwright's `project#<id>` fixture-pool location —
 * even when it's the only source the model recorded. */
function pickDefaultFile(
  frame: StackFrame | undefined,
  sources: TraceTabProps["model"]["sources"],
): string | undefined {
  if (frame && isRealSourceFile(frame.file) && sources.has(frame.file)) {
    return frame.file;
  }
  for (const [file, source] of sources) {
    if (isRealSourceFile(file) && source.errors.length > 0) return file;
  }
  for (const file of sources.keys()) {
    if (isRealSourceFile(file)) return file;
  }
  return undefined;
}

/**
 * Read-only source view for the selected action's stack frame, with a stack
 * frame picker alongside it. Keyed on the selected action by `DetailTabs`,
 * so a selection change remounts it (fresh default file + frame index)
 * instead of reconciling stale manual picks against a new stack.
 */
export function SourceTab(props: TraceTabProps): React.ReactElement {
  const { model, selectedAction, traceUrl, bridge } = props;
  const files = Array.from(model.sources.keys()).filter(isRealSourceFile);
  const [manualFile, setManualFile] = useState<string | undefined>(undefined);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);

  const stack = selectedAction?.stack ?? [];
  const selectedFrame = stack[selectedFrameIndex];

  const file = manualFile ?? pickDefaultFile(selectedFrame, model.sources);
  const source = file ? model.sources.get(file) : undefined;

  // Fetch keyed on `file`, so a file switch can never render the previous
  // file's text under the new file's tab/dialect/error lines. The fetched
  // text is cached on the shared model (mirroring the upstream viewer's
  // lazy-fill of `SourceModel.content`), so later tab visits skip the fetch.
  const needsFetch = source !== undefined && source.content === undefined;
  const fetched = useBridgeFetch(
    bridge,
    needsFetch && file ? file : null,
    async (sourceFile) => {
      const sha1 = await sha1Hex(sourceFile);
      const blob = await bridge.fetchBlob(
        sha1Path(traceUrl, `src@${sha1}.txt`),
      );
      const text = await blob.text();
      const cached = model.sources.get(sourceFile);
      if (cached) cached.content = text;
      return text;
    },
  );
  const content = source?.content ?? fetched.value;
  const fetchError = fetched.error?.message;

  if (files.length === 0 || !file) {
    return <TabNotice>Source view is not available yet.</TabNotice>;
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
            className="shrink-0 truncate border-b border-line-1 px-3 py-1.5 text-caption text-fg-3"
            title={file}
          >
            {basename(file)}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {fetchError ? (
            <div className="px-3 py-2 text-caption text-fg-4">{fetchError}</div>
          ) : content === undefined ? null : (
            <SourceLines
              content={content}
              errors={errors}
              file={file}
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
 * source for), or whose file is a Playwright-synthesized non-file location
 * (`isRealSourceFile`), render disabled.
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
        const available =
          isRealSourceFile(frame.file) && sources.has(frame.file);
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
                "truncate text-caption",
                available ? "text-fg-3" : "text-fg-4",
              )}
            >
              {frame.function || "(anonymous)"}
            </span>
            <span
              className={cn(
                "truncate font-mono text-caption",
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

type TokenSegment = { text: string; className: string | undefined };

/** File extensions `@lezer/javascript` can parse, and the dialect flags each
 * one needs (mirrors `@codemirror/lang-javascript`'s own `configure` calls —
 * see node_modules/@codemirror/lang-javascript/dist/index.js). Anything else
 * (`.py`, `.json`, `.css`, …) falls back to unhighlighted text rather than
 * risk running the JS/TS grammar over the wrong language. */
const JS_TS_DIALECTS: Record<string, string | undefined> = {
  js: undefined,
  mjs: undefined,
  cjs: undefined,
  jsx: "jsx",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "ts jsx",
};

function fileExtension(file: string): string | undefined {
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? undefined : base.slice(dot + 1).toLowerCase();
}

/**
 * Tokenize `content` into `tok-*`-classed segments, one array per line
 * (mirroring `content.split("\n")`'s line count exactly, since
 * `highlightCode`'s `putBreak` fires once per `\n` and never bundles a
 * break into a text chunk). Returns `undefined` for extensions outside the
 * JS/TS family — callers should render plain text in that case rather than
 * run the wrong grammar over it.
 */
function tokenizeSource(
  content: string,
  file: string,
): TokenSegment[][] | undefined {
  const ext = fileExtension(file);
  if (ext === undefined || !(ext in JS_TS_DIALECTS)) return undefined;
  const dialect = JS_TS_DIALECTS[ext];
  try {
    const langParser = dialect ? jsParser.configure({ dialect }) : jsParser;
    const tree = langParser.parse(content);
    const lines: TokenSegment[][] = [[]];
    highlightCode(
      content,
      tree,
      classHighlighter,
      (text, classes) => {
        lines[lines.length - 1]?.push({
          text,
          className: classes || undefined,
        });
      },
      () => {
        lines.push([]);
      },
    );
    return lines;
  } catch {
    // Malformed/unexpected content — fall back to plain text rather than
    // surface a parser error in a read-only source view.
    return undefined;
  }
}

/**
 * Line-numbered `<pre>` renderer: target line highlighted + scrolled into
 * view, error lines tinted with their message inline beneath. Line text is
 * tokenized with pure `@lezer/javascript` + `@lezer/highlight`
 * (`tokenizeSource` above) rather than CodeMirror — a CodeMirror
 * (`@uiw/react-codemirror`) variant was attempted and REVERTED: custom
 * decoration extensions built outside the wrapper hit "multiple instances
 * of @codemirror/state" under Vite dev pre-bundling (instanceof breakage),
 * silently falling back anyway. The lezer parser/highlighter packages used
 * here never touch `@codemirror/state`, so that dedupe failure mode doesn't
 * apply — no `<CodeMirror>` element is ever mounted for this tab.
 */
function SourceLines({
  content,
  errors,
  file,
  targetLine,
}: {
  content: string;
  errors: { line: number; message: string }[];
  file: string;
  targetLine: number | undefined;
}): React.ReactElement {
  const lines = content.split("\n");
  const tokenLines = useMemo(
    () => tokenizeSource(content, file),
    [content, file],
  );
  const errorsByLine = new Map<number, string>();
  for (const error of errors) errorsByLine.set(error.line, error.message);
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [targetLine, content]);

  return (
    <pre className="trace-source min-w-max py-1 font-mono text-body leading-5">
      {lines.map((line, i) => {
        const lineNumber = i + 1;
        const isTarget = lineNumber === targetLine;
        const errorMessage = errorsByLine.get(lineNumber);
        const tokenLine = tokenLines?.[i];
        return (
          <div key={lineNumber}>
            <div
              className={cn(
                "flex gap-3 px-3",
                // Inset accent bar (not border-l) so the highlight doesn't
                // shift the line's flex content. Error tint takes priority
                // over the target tint when a line is both.
                isTarget &&
                  "bg-running-soft shadow-[inset_2px_0_0_var(--color-running)]",
                errorMessage && "bg-fail-soft",
              )}
              ref={isTarget ? targetRef : undefined}
            >
              <span className="w-8 shrink-0 select-none text-right tabular-nums text-fg-4">
                {lineNumber}
              </span>
              <span className="whitespace-pre">
                {tokenLine
                  ? tokenLine.length > 0
                    ? tokenLine.map((segment, segmentIndex) => (
                        <span className={segment.className} key={segmentIndex}>
                          {segment.text}
                        </span>
                      ))
                    : " "
                  : line || " "}
              </span>
            </div>
            {errorMessage ? (
              <div className="ml-11 whitespace-pre-wrap break-words px-3 py-1 text-caption text-fail">
                {errorMessage}
              </div>
            ) : null}
          </div>
        );
      })}
    </pre>
  );
}
