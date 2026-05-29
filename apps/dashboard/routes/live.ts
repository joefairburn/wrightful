import { defineHandler } from "void";
import { live } from "@/live";

/**
 * WebSocket connect endpoint for the app-wide live stream. The browser opens
 * `wss://.../live` and then sends `subscribe` control frames per topic — see
 * `live.ts` and `void/live` docs for protocol details.
 */
export const GET = defineHandler((c) => live.connect(c));

/**
 * HTTP control endpoint for subscribe/unsubscribe operations. Same stream;
 * the void/live client may switch between WS and POST depending on transport
 * availability.
 */
export const POST = defineHandler((c) => live.control(c));
