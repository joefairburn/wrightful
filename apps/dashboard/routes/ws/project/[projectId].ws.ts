import { defineRoom } from "void/ws";
import { env } from "void/env";
import { authorizeTopicSubscription } from "@/lib/authz";
import {
  projectRoomClientSchema,
  projectRoomServerSchema,
} from "@/realtime/events";
import {
  isInternalRequest,
  resolveInternalSecret,
  roomAtCapacity,
} from "@/realtime/room-server";

/**
 * Runs-list live feed over a hibernatable `void/ws` room — one Durable Object
 * per project (`projectId=<id>`), shared by all viewers of that project's runs
 * list. Server-push only: clients receive `run-created` / `run-progress` and
 * never send (the client schema is a no-op `ping`).
 *
 * The room hibernates when idle (no events) — see docs/adr/0001 — so an
 * open-but-idle list tab bills ~0 duration. Kept strictly heartbeat-free +
 * presence-free so that idle-hibernation property holds.
 */
export default defineRoom({
  messages: {
    client: projectRoomClientSchema,
    server: projectRoomServerSchema,
  },

  /**
   * Tenant-isolation gate, reusing the exact decision the SSE stream used
   * (`authorizeTopicSubscription` → project-team membership). `ctx.user` is
   * resolved from the Better Auth session cookie on the WS upgrade and is
   * already typed `AuthUser | null` by RoomContext (no cast needed). A
   * connection cap backstops fan-out / abuse per room.
   */
  async onBeforeConnect(ctx) {
    if (roomAtCapacity(ctx.room.getConnections())) {
      return new Response("Too Many Requests", { status: 429 });
    }
    const decision = await authorizeTopicSubscription(
      ctx.user?.id ?? null,
      `project:${ctx.params.projectId}`,
    );
    if (!decision.ok) {
      return new Response("Forbidden", { status: decision.status });
    }
  },

  /**
   * Ingest publishes here via a DO-to-DO POST (see `src/realtime/publish.ts`).
   * Void also registers this room's path as a public `app.all` route, so a
   * forged POST from any logged-in user would otherwise reach `broadcast`. Gate
   * it with the constant-time internal-secret check (the only guard on this
   * path), and parse the body through the server schema so a malformed payload
   * is rejected before fan-out rather than asserted and broadcast.
   */
  async onRequest(ctx) {
    if (ctx.request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!isInternalRequest(ctx.request, resolveInternalSecret(env))) {
      return new Response("Forbidden", { status: 403 });
    }
    const parsed = projectRoomServerSchema.safeParse(await ctx.request.json());
    if (!parsed.success) {
      return new Response("Bad Request", { status: 400 });
    }
    await ctx.room.broadcast(parsed.data);
    return Response.json({ ok: true });
  },
});
