"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import type { TraceTabProps } from "../model";
import { sha1Path } from "../model";

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

/** Default file: the selected action's top stack frame, else the first file
 * carrying an error, else whichever file the model saw first. */
function pickDefaultFile(
  selectedAction: TraceTabProps["selectedAction"],
  sources: TraceTabProps["model"]["sources"],
): string | undefined {
  const topFrameFile = selectedAction?.stack?.[0]?.file;
  if (topFrameFile && sources.has(topFrameFile)) return topFrameFile;
  for (const [file, source] of sources) {
    if (source.errors.length > 0) return file;
  }
  return sources.keys().next().value;
}

/**
 * Read-only source view for the selected action's stack frame.
 *
 * Neither `ui/code-editor.tsx` nor `ui/code-editor-codemirror.tsx` fits this:
 * `CodeEditor`'s `readOnly` path deliberately renders the plain
 * gutter-faking `<textarea>` fallback rather than mounting CodeMirror (see
 * its file comment), so it can't scroll to or highlight a specific line; the
 * lower-level `CodeMirrorField` has no `readOnly`/highlight/reveal props at
 * all. Both only expose a fixed height and a controlled `value`. So this
 * renders its own simple line-numbered `<pre>`, styled to match the same
 * gutter treatment as `CodeEditor`'s fallback, which is the sanctioned
 * escape hatch for exactly this gap.
 */
export function SourceTab(props: TraceTabProps): React.ReactElement {
  const { model, selectedAction, traceUrl, bridge } = props;
  const files = Array.from(model.sources.keys());
  const [manualFile, setManualFile] = useState<string | undefined>(undefined);

  useEffect(() => {
    setManualFile(undefined);
  }, [selectedAction?.callId]);

  const file = manualFile ?? pickDefaultFile(selectedAction, model.sources);
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

  const topFrame = selectedAction?.stack?.[0];
  const targetLine =
    topFrame?.file === file ? topFrame.line : source?.errors[0]?.line;
  const errors = source?.errors ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {files.length > 1 ? (
        <TabBar className="shrink-0 px-2" role="tablist" scrollable>
          {files.map((f) => (
            <span key={f} title={f}>
              <TabBarTab active={f === file} onSelect={() => setManualFile(f)}>
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
  );
}

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
              ref={isTarget ? targetRef : undefined}
              className={cn(
                "flex gap-3 px-3",
                isTarget && "bg-bg-2",
                errorMessage && "bg-fail-soft",
              )}
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
