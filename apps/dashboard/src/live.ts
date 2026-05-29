import { defineLiveStream } from "void/live";
import { getSession } from "void/auth";
import { db, and, eq } from "void/db";
import { memberships, runs } from "@schema";

/**
 * App-wide live stream. Replaces the old `SyncedStateServer` DO + room-handler
 * model. One stream serves every topic the dashboard subscribes to.
 *
 * Topic taxonomy:
 *   - `run:<runId>` — progress + status snapshots for an in-flight run.
 *     Published from `routes/api/runs/*` after each ingest write.
 *
 * Auth model:
 *   - `identifyConnection` tags the connection with `user:<id>` from the
 *     void-auth session. Returning `null` here combined with
 *     `allowAnonymousControl: false` (the default) makes void reject the
 *     handshake outright — see `node_modules/void/dist/runtime/live.mjs`.
 *     So anonymous traffic never reaches `onSubscribe`.
 *   - `onSubscribe` runs a per-topic membership check: subscribing to
 *     `run:<runId>` requires the user (already validated, available on
 *     `ctx.user`) to be a member of the run's team. One indexed join
 *     resolves both lookups.
 */
export const live = defineLiveStream({
  id: "app",
  identifyConnection() {
    const session = getSession();
    return session ? `user:${session.user.id}` : null;
  },
  async onSubscribe(ctx) {
    // `ctx.user` is plumbed through by void from `identifyConnection` —
    // re-reading the session here would be redundant. With anonymous control
    // disabled (the default), this hook only runs for identified connections.
    const user = ctx.user as { id: string } | null;
    if (!user) return new Response("Forbidden", { status: 403 });
    const runMatch = ctx.topic.match(/^run:([^:]+)$/);
    if (runMatch) {
      const runId = runMatch[1];
      const rows = await db
        .select({ teamId: runs.teamId })
        .from(runs)
        .innerJoin(
          memberships,
          and(
            eq(memberships.teamId, runs.teamId),
            eq(memberships.userId, user.id),
          ),
        )
        .where(eq(runs.id, runId))
        .limit(1);
      if (rows.length === 0) {
        return new Response("Forbidden", { status: 403 });
      }
      return;
    }
    return new Response("Forbidden", { status: 403 });
  },
  limits: {
    // Hard ceiling on concurrent viewers of a single run. 256 covers normal CI
    // dashboards; revisit if we start broadcasting to wider audiences (status
    // pages, team-wide live overviews). Above this, `subscribe` returns
    // `TOPIC_FULL` and the client surfaces it as a failed subscription.
    maxSubscriptionsPerTopic: 256,
  },
});

/** Wire-format shape mirrored on the dashboard client. */
export interface RunProgressTest {
  id: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface RunProgressEvent {
  type: "progress";
  /** Tests that changed in this push. Client merges by id into its accumulator. */
  changedTests: RunProgressTest[];
  /** Latest aggregate snapshot. */
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
 * Publish a snapshot to every subscriber of `run:<runId>`. Awaited so the
 * ingest write isn't lost to fire-and-forget workerd termination.
 */
export async function publishRunUpdate(
  runId: string,
  event: RunProgressEvent,
): Promise<void> {
  await live.publish(`run:${runId}`, event, {
    type: "progress",
  });
}
