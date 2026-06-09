import { requireRuntimeBinding } from "void/_env";
import { env } from "void/env";
import { logger } from "void/log";
import { buildWebSocketInstanceId } from "void/runtime/ws-server";
import type { ProjectRoomEvent, RunRoomEvent } from "@/realtime/events";
import { INTERNAL_HEADER, resolveInternalSecret } from "@/realtime/room-server";

/**
 * Server-side publishers for the `void/ws` rooms — the single realtime publish
 * path. Ingest call sites stay one-liners (`broadcastRunRoom` /
 * `broadcastProjectRoom`).
 *
 * Each reaches the room DO by resolving the namespace binding from the
 * AsyncLocalStorage runtime env, then
 * `idFromName(buildWebSocketInstanceId(...))` to the per-scope instance — and
 * POST the event so the room's `onRequest` hook broadcasts it. The
 * `x-wrightful-internal` header is the shared secret that distinguishes this
 * trusted server call from a forged POST to the room's public path.
 *
 * NON-FATAL by design: a realtime delivery hiccup must never fail the ingest
 * write (the data is already in D1). We still `await` (no fire-and-forget —
 * workerd would drop an unawaited promise after the response) but swallow + log.
 *
 * Room DO binding names equal their generated class names (Void derives both
 * from the route file path; see void scan `bindingName: className`). Keep these
 * in sync if the room route files under `routes/ws/` move — `publish.test.ts`
 * pins the binding name → instance-id → header → POST contract.
 */

async function postToRoom(
  bindingName: string,
  paramName: string,
  paramValue: string,
  path: string,
  event: unknown,
): Promise<void> {
  try {
    // `requireRuntimeBinding<T>` is generic — name the DO namespace type so
    // idFromName/get are checked (an id/name swap is caught), no `as` cast.
    const ns = requireRuntimeBinding<DurableObjectNamespace>(bindingName);
    const id = ns.idFromName(
      buildWebSocketInstanceId(
        { params: [paramName] },
        {
          [paramName]: paramValue,
        },
      ),
    );
    const res = await ns.get(id).fetch(
      new Request(`https://void.local${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_HEADER]: resolveInternalSecret(env),
        },
        body: JSON.stringify(event),
      }),
    );
    if (!res.ok) {
      logger.warn("ws room broadcast non-ok", {
        binding: bindingName,
        status: res.status,
      });
    }
  } catch (err) {
    logger.error("ws room broadcast failed", {
      binding: bindingName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** routes/ws/project/[projectId].ws.ts → WsProjectProjectIdWs */
export function broadcastProjectRoom(
  projectId: string,
  event: ProjectRoomEvent,
): Promise<void> {
  return postToRoom(
    "WsProjectProjectIdWs",
    "projectId",
    projectId,
    `/ws/project/${projectId}`,
    event,
  );
}

/** routes/ws/run/[runId].ws.ts → WsRunRunIdWs */
export function broadcastRunRoom(
  runId: string,
  event: RunRoomEvent,
): Promise<void> {
  return postToRoom("WsRunRunIdWs", "runId", runId, `/ws/run/${runId}`, event);
}
