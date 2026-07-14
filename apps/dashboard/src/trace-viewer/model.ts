import type { TraceBridge } from "./use-trace-model";
import type {
  ActionTraceEventInContext,
  TraceModel,
} from "./vendor/model-util";
import {
  context,
  nextActionByStartTime,
  previousActionByEndTime,
} from "./vendor/model-util";
import type { ActionTraceEvent } from "./vendor/trace";

/**
 * Adapter between the vendored Playwright trace model (`vendor/model-util.ts`)
 * and our workbench UI: snapshot-tab derivation and snapshot iframe URLs.
 * The derivation logic is a faithful port of the official viewer's
 * `snapshotTab.tsx` (`collectSnapshots` / `extendSnapshot`, playwright
 * v1.61.1) — see `.context/trace-viewer-ui-reference.md` for the quoted
 * source it mirrors. Keep it behavior-identical when touching.
 */

/** The SW scope every snapshot/resource URL must live under. */
export const TRACE_VIEWER_SCOPE = "/trace-viewer/";

export type SnapshotTabId = "action" | "before" | "after";

export type Snapshot = {
  action: ActionTraceEvent;
  snapshotName: string;
  pageId: string;
  point?: { x: number; y: number };
};

export type SnapshotSet = {
  action?: Snapshot;
  before?: Snapshot;
  after?: Snapshot;
};

/** Props shared by every detail tab in the workbench. */
export type TraceTabProps = {
  model: TraceModel;
  selectedAction: ActionTraceEventInContext | undefined;
  /**
   * The hover-aware action mirroring the snapshot canvas: the hovered
   * action-list row while previewing, else `selectedAction` (the workbench
   * computes `hoveredAction ?? selectedAction` once and shares it). Tabs that
   * render ONE action's detail (Call/Log/Source) key on this, matching the
   * official viewer's `highlightedAction || selectedAction`. Selection-scoped
   * tabs deliberately stay on `selectedAction` instead — Console/Network's
   * highlighting + `scopeToSelected` window, and Attachments — so a hover
   * sweep can't yank filters or scroll positions.
   */
  activeAction: ActionTraceEventInContext | undefined;
  /** Select an action in the action list (e.g. from an error's link). */
  onSelectAction: (callId: string) => void;
  /** The absolute trace URL (drives SW-served attachment/resource links). */
  traceUrl: string;
  /** Fetch proxy into the SW-controlled bridge (sha1 bytes, snapshotInfo…). */
  bridge: TraceBridge;
  /**
   * When set, time-windowed tabs (Console/Network) FILTER to the selected
   * action's window instead of merely highlighting it.
   */
  scopeToSelected: boolean;
};

function createSnapshot(
  action: ActionTraceEvent | undefined,
  snapshotNameKey: "beforeSnapshot" | "afterSnapshot" | "inputSnapshot",
): Snapshot | undefined {
  if (!action) return undefined;
  const snapshotName = action[snapshotNameKey];
  if (!snapshotName) return undefined;
  // A snapshot must belong to a page to be addressable (`snapshot/<pageId>`).
  if (!action.pageId) return undefined;
  return { action, snapshotName, pageId: action.pageId, point: action.point };
}

/**
 * Derive the three snapshot tabs for an action, with the official viewer's
 * fallback walks: a missing `beforeSnapshot` borrows the nearest preceding
 * action's `afterSnapshot`; a missing `afterSnapshot` (e.g. a `test.step`
 * wrapper) borrows the latest-ending descendant's; the "action" tab falls
 * back to "after" but always carries this action's input point.
 */
export function collectSnapshots(
  action: ActionTraceEventInContext | undefined,
): SnapshotSet {
  if (!action) return {};

  let before = createSnapshot(action, "beforeSnapshot");
  let after = createSnapshot(action, "afterSnapshot");

  if (!before) {
    for (
      let a = previousActionByEndTime(action);
      a;
      a = previousActionByEndTime(a)
    ) {
      if (a.endTime <= action.startTime) {
        const snapshot = createSnapshot(a, "afterSnapshot");
        if (snapshot) {
          before = snapshot;
          break;
        }
      }
    }
  }

  if (!after) {
    // The latest-ENDING descendant (max endTime), matching upstream
    // collectSnapshots — not the latest-starting one. Iteration is by start
    // time, so the last qualifying action isn't necessarily the last to end
    // (an earlier-starting descendant can span past a later-starting one).
    let latest: Snapshot | undefined;
    for (
      let a = nextActionByStartTime(action);
      a && a.startTime <= action.endTime;
      a = nextActionByStartTime(a)
    ) {
      if (
        a.endTime <= action.endTime &&
        (!latest || a.endTime >= latest.action.endTime)
      ) {
        const snapshot = createSnapshot(a, "afterSnapshot");
        if (snapshot) latest = snapshot;
      }
    }
    after = latest ?? before;
  }

  const actionSnapshot = createSnapshot(action, "inputSnapshot") ?? after;
  return {
    action: actionSnapshot
      ? { ...actionSnapshot, point: action.point }
      : undefined,
    before,
    after,
  };
}

/**
 * Build the SW-served snapshot document URL
 * (`/trace-viewer/snapshot/<pageId>?trace=…&name=…[&pointX=&pointY=]`).
 * Iframe NAVIGATIONS to this URL are handled by the service worker no matter
 * which page creates the iframe — only fetch()es require a controlled client.
 */
export function snapshotIframeUrl(
  traceUrl: string,
  snapshot: Snapshot,
): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  params.set("name", snapshot.snapshotName);
  if (snapshot.point) {
    params.set("pointX", String(snapshot.point.x));
    params.set("pointY", String(snapshot.point.y));
  }
  return `${TRACE_VIEWER_SCOPE}snapshot/${snapshot.pageId}?${params.toString()}`;
}

/**
 * Sidecar metadata for a snapshot (`snapshotInfo/<pageId>?…`): the page URL
 * at capture time and the EXACT viewport (correct even when a test resizes
 * mid-run). Fetch through the bridge proxy — the SW only answers controlled
 * clients. A discriminated union rather than an optional `error` field on
 * the success shape — the two are mutually exclusive on the wire (the SW
 * sidecar either resolves the snapshot or reports why it couldn't), and this
 * keeps `.url`/`.viewport` accessible without an `error` narrowing check at
 * every call site.
 */
export type SnapshotInfo = SnapshotInfoError | ResolvedSnapshotInfo;

export type SnapshotInfoError = { error: string };

export type ResolvedSnapshotInfo = {
  url: string;
  viewport: { width: number; height: number };
  timestamp?: number;
  wallTime?: number;
};

/**
 * Validate + narrow a `snapshotInfo/` sidecar response of unknown shape (it
 * crosses the bridge `fetchJson` boundary as `unknown`). Returns `null` for
 * anything that isn't a recognizable `SnapshotInfo` — malformed sidecars are
 * treated the same as a fetch failure by callers (fall back silently).
 */
export function parseSnapshotInfo(raw: unknown): SnapshotInfo | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.error === "string") return { error: raw.error };
  if (typeof raw.url !== "string") return null;
  const viewport = raw.viewport;
  if (!isRecord(viewport)) return null;
  const { width, height } = viewport;
  if (typeof width !== "number" || typeof height !== "number") return null;
  const timestamp =
    typeof raw.timestamp === "number" ? raw.timestamp : undefined;
  const wallTime = typeof raw.wallTime === "number" ? raw.wallTime : undefined;
  return { url: raw.url, viewport: { width, height }, timestamp, wallTime };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Popout URL for opening one rendered snapshot in a new tab, via the
 * vendored `snapshot.html` shell (`?r=<absolute snapshot URL>&trace=…`) —
 * same shape the official viewer builds. `absoluteSnapshotUrl` must be
 * absolute (resolve `snapshotIframeUrl` against the page origin first).
 */
export function snapshotPopoutUrl(
  traceUrl: string,
  absoluteSnapshotUrl: string,
): string {
  const params = new URLSearchParams();
  params.set("r", absoluteSnapshotUrl);
  params.set("trace", traceUrl);
  return `${TRACE_VIEWER_SCOPE}snapshot.html?${params.toString()}`;
}

/** Bridge-proxy path for a snapshot's `snapshotInfo/` sidecar JSON. */
export function snapshotInfoPath(traceUrl: string, snapshot: Snapshot): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  params.set("name", snapshot.snapshotName);
  return `snapshotInfo/${snapshot.pageId}?${params.toString()}`;
}

/**
 * Bridge-proxy path for trace bytes by sha1 — source files
 * (`src@<hash>.txt`), attachment bodies, and screencast frames (whose "sha1"
 * is really the archive filename `page@<id>-<ts>.jpeg`; same SW route).
 */
export function sha1Path(traceUrl: string, sha1: string): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  return `sha1/${sha1}?${params.toString()}`;
}

/**
 * SW-served attachment/resource bytes by sha1. Only usable as a NAVIGATION
 * (link click / new tab), not as a fetch/img subresource — see
 * `snapshotIframeUrl`. `dn`/`dct` drive the SW's Content-Disposition.
 */
export function sha1DownloadUrl(
  traceUrl: string,
  sha1: string,
  name: string,
  contentType: string,
): string {
  const params = new URLSearchParams();
  params.set("trace", traceUrl);
  params.set("dn", name);
  params.set("dct", contentType);
  return `${TRACE_VIEWER_SCOPE}sha1/${sha1}?${params.toString()}`;
}

/**
 * Playwright synthesizes non-file stack locations for actions that don't
 * originate from a test file on disk — e.g. `project#<projectId>` for
 * project-level fixture option overrides (playwright v1.61.1,
 * packages/playwright/src/common, `_buildTestTypePool`). Those synthetic
 * frames land in fixture-setup actions' stacks alongside real ones; anything
 * without a path separator is not a real source file and gets no tab/frame
 * in the Source view.
 */
export function isRealSourceFile(file: string): boolean {
  return file.includes("/") || file.includes("\\");
}

/** Human title for an action row ("locator.click" etc. + selector-ish hint). */
export function actionTitle(action: ActionTraceEvent): string {
  return action.title || `${action.class}.${action.method}`;
}

/**
 * The searchable free-text hint shown beside an action's title (the selector,
 * URL, or evaluated expression) — the dimmed second line in an action row and
 * in the timeline hover preview. Empty when the action carries none of them.
 */
export function actionParamHint(action: ActionTraceEvent): string {
  const params: Record<string, unknown> = action.params ?? {};
  if (typeof params.selector === "string") return params.selector;
  if (typeof params.url === "string") return params.url;
  if (typeof params.expression === "string") return params.expression;
  return "";
}

/**
 * The viewport used to size/scale a snapshot: the recorded browser-context
 * viewport (falls back to Playwright's default). The official viewer reads
 * the per-snapshot `snapshotInfo/` sidecar instead, but that endpoint needs
 * a SW-controlled client fetch; the context viewport is right except when a
 * test resizes the viewport mid-run.
 */
export function snapshotViewport(action: ActionTraceEventInContext): {
  width: number;
  height: number;
} {
  return context(action)?.options?.viewport ?? { width: 1280, height: 720 };
}

/**
 * Default selection for a freshly loaded trace: the first action that failed,
 * else the last action (the terminal state a user usually wants to see).
 */
export function defaultSelectedActionId(model: TraceModel): string | undefined {
  const failed = model.actions.find((a) => a.error?.message);
  const target = failed ?? model.actions[model.actions.length - 1];
  return target?.callId;
}

const TRACE_VERSION_ERROR_SNIPPET = "created by a newer version of Playwright";

/**
 * Friendlier copy for the one loader failure users can't do anything about
 * from the browser: the vendored viewer being older than the trace.
 */
export function describeTraceLoadError(error: string): string {
  if (error.includes(TRACE_VERSION_ERROR_SNIPPET)) {
    return "This trace was recorded with a newer Playwright version than the dashboard's replay engine supports. Download the trace and open it in the public viewer instead.";
  }
  return error;
}
