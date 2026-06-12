import { defineRoom } from "void/ws";
import { env } from "void/env";
import { authorizeTopicSubscription } from "@/lib/authz";
import { runRoomClientSchema, runRoomServerSchema } from "@/realtime/events";
import {
  isAllowedWsOrigin,
  isInternalRequest,
  resolveInternalSecret,
  roomAtCapacity,
} from "@/realtime/room-server";

/**
 * Run-detail live feed over a hibernatable `void/ws` room — one Durable Object
 * per run (`runId=<id>`), shared by everyone viewing that run. Carries the
 * fine-grained `progress` event (summary + changed per-test rows); see
 * docs/adr/0001.
 *
 * Server-push only + heartbeat-free + presence-free, so the room hibernates when
 * idle (a run streams for minutes; a detail tab can stay open far longer).
 */
export default defineRoom({
  messages: {
    client: runRoomClientSchema,
    server: runRoomServerSchema,
  },

  // Same tenant-isolation gate the SSE stream used: member of the run's team.
  // `ctx.user` is already typed `AuthUser | null` by RoomContext (no cast).
  // Origin first: cross-site browser upgrades are rejected outright rather
  // than relying on SameSite cookie defaults alone (defense in depth).
  // Same-origin is judged against the upgrade's own Host (any domain routed
  // to this worker), with WRIGHTFUL_PUBLIC_URL as belt-and-braces.
  async onBeforeConnect(ctx) {
    const origin = ctx.request.headers.get("origin");
    const host = ctx.request.headers.get("host");
    if (!isAllowedWsOrigin(origin, host, env.WRIGHTFUL_PUBLIC_URL)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (roomAtCapacity(ctx.room.getConnections())) {
      return new Response("Too Many Requests", { status: 429 });
    }
    const decision = await authorizeTopicSubscription(
      ctx.user?.id ?? null,
      `run:${ctx.params.runId}`,
    );
    if (!decision.ok) {
      return new Response("Forbidden", { status: decision.status });
    }
  },

  // Ingest publishes here via a DO-to-DO POST (see `src/realtime/publish.ts`).
  // Void registers this path as a public route, so the constant-time internal
  // secret check is the only gate against a forged broadcast. The body is parsed
  // through the server schema (not asserted) so a malformed payload is rejected
  // before fan-out.
  async onRequest(ctx) {
    if (ctx.request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!isInternalRequest(ctx.request, resolveInternalSecret(env))) {
      return new Response("Forbidden", { status: 403 });
    }
    const parsed = runRoomServerSchema.safeParse(await ctx.request.json());
    if (!parsed.success) {
      return new Response("Bad Request", { status: 400 });
    }
    await ctx.room.broadcast(parsed.data);
    return Response.json({ ok: true });
  },
});
