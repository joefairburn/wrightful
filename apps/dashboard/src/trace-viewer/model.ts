import type {
  ActionTraceEventInContext,
  MultiTraceModel,
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
  model: MultiTraceModel;
  selectedAction: ActionTraceEventInContext | undefined;
  /** Select an action in the action list (e.g. from an error's link). */
  onSelectAction: (callId: string) => void;
  /** The absolute trace URL (drives SW-served attachment/resource links). */
  traceUrl: string;
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
    let last: Snapshot | undefined;
    for (
      let a = nextActionByStartTime(action);
      a && a.startTime <= action.endTime;
      a = nextActionByStartTime(a)
    ) {
      if (a.endTime <= action.endTime) {
        const snapshot = createSnapshot(a, "afterSnapshot");
        if (snapshot) last = snapshot;
      }
    }
    after = last ?? before;
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

/** Human title for an action row ("locator.click" etc. + selector-ish hint). */
export function actionTitle(action: ActionTraceEvent): string {
  return action.title || `${action.class}.${action.method}`;
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
export function defaultSelectedActionId(
  model: MultiTraceModel,
): string | undefined {
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
