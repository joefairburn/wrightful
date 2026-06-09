import { z } from "zod";

/**
 * Realtime wire contracts for the `void/ws` rooms (ADR 0001). These are the
 * payloads ingest constructs and broadcasts, and the dashboard client folds
 * through the pure reducers (`applyProjectFeedEvent` / `applyRunProgressEvent`).
 * They live here, co-located with the room schemas, because the schemas type
 * exactly against them.
 */

/**
 * Per-test wire row for the live run-detail list. Deliberately a SUBSET of the
 * persisted test result: it carries only the fields the live list renders
 * (status / title / file / projectName / duration / retryCount). It intentionally
 * does NOT carry `errorMessage` / `errorStack` — those are large (up to ~64 KiB +
 * ~128 KiB each) and would bloat every broadcast (risking the WS frame ceiling,
 * which would drop the whole event — summary included — for every viewer) while
 * the live list never renders them; the test-detail page loads error text from
 * D1 on demand instead.
 */
export interface RunProgressTest {
  id: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  durationMs: number;
  retryCount: number;
}

/**
 * The fine-grained per-run progress event carried on the run room
 * (`run:<runId>`): the tests that changed in this push (merged by id into the
 * client accumulator) plus the latest aggregate snapshot.
 */
export interface RunProgressEvent {
  type: "progress";
  changedTests: RunProgressTest[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    durationMs: number;
    status: string;
    completedAt: number | null;
  };
}

/**
 * Row snapshot the runs list renders. A structural superset of the live
 * aggregate (the `summary` fields) plus the static run metadata, carried whole
 * on a `run-created` project-feed event so the list can render a brand-new row
 * without a re-fetch. The `runs` table row satisfies this shape, so ingest can
 * pass one straight through.
 */
export interface RunListRowData {
  id: string;
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  durationMs: number;
  completedAt: number | null;
  createdAt: number;
  branch: string | null;
  prNumber: number | null;
  commitSha: string | null;
  commitMessage: string | null;
  environment: string | null;
  actor: string | null;
  ciProvider: string | null;
  repo: string | null;
}

/**
 * Project-wide feed (`project:<projectId>`) powering the runs list:
 *   - `run-created` — a run just opened; the list prepends its row.
 *   - `run-progress` — an existing run's aggregate advanced (or it finalized);
 *     the list updates that row's status / counts / duration.
 * Authorized per topic by `authorizeTopicSubscription` (project membership).
 */
export type ProjectFeedEvent =
  | { type: "run-created"; run: RunListRowData }
  | {
      type: "run-progress";
      runId: string;
      summary: RunProgressEvent["summary"];
    };

/**
 * The project room carries exactly the project feed's lifecycle events — the
 * page reducer (`applyProjectFeedEvent`) consumes the value unchanged.
 */
export type ProjectRoomEvent = ProjectFeedEvent;

/** Narrow `unknown` to a plain object (not null, not an array) for schema guards. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Standard-Schema validators for the rooms' server messages (zod implements
 * `~standard`, which `void/ws` runs inside `broadcast` AND which we run on the
 * trusted-internal POST body in each room's `onRequest`). The complex nested
 * payloads use `z.custom<T>(guard)` so the schema (a) **infers exactly** the wire
 * type — so `ctx.room.broadcast(event)` type-checks against the value ingest
 * constructs without duplicating the interface as a `z.object` (which would fork
 * the source of truth) — and (b) still **rejects structurally wrong values** at
 * runtime via a real guard predicate (not the old permissive `() => true`):
 * `changedTests` must be an array (a non-array would otherwise throw in the
 * reducer's `for…of`), `run` must be an object with a string `id`. The scalar
 * `summary` is validated field-by-field as a real `z.object`. Type safety at the
 * construction site (`publish.ts` / `ingest.ts`) covers the rest.
 */
const summarySchema = z.object({
  totalTests: z.number(),
  passed: z.number(),
  failed: z.number(),
  flaky: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
  status: z.string(),
  completedAt: z.number().nullable(),
}) satisfies z.ZodType<RunProgressEvent["summary"]>;

export const projectRoomServerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run-created"),
    run: z.custom<RunListRowData>(
      (v) => isRecord(v) && typeof v.id === "string",
    ),
  }),
  z.object({
    type: z.literal("run-progress"),
    runId: z.string(),
    summary: summarySchema,
  }),
]);

/**
 * Clients are receive-only on this room (server-push). A no-op `ping` keeps the
 * required client schema valid without inviting client→server traffic — every
 * incoming WS message bills (20:1) and wakes the DO, eroding the idle
 * hibernation, so we keep the room heartbeat-free.
 */
export const projectRoomClientSchema = z.object({ type: z.literal("ping") });

/**
 * Run-detail room events — the fine-grained per-run `progress` event (summary +
 * changed per-test rows). Same guard approach as the project room.
 */
export type RunRoomEvent = RunProgressEvent;

export const runRoomServerSchema = z.object({
  type: z.literal("progress"),
  changedTests: z.custom<RunProgressEvent["changedTests"]>((v) =>
    Array.isArray(v),
  ),
  summary: summarySchema,
});

export const runRoomClientSchema = z.object({ type: z.literal("ping") });
