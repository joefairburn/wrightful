// Minimal worker entry for integration tests. Only exports what
// `wrangler.test.jsonc` binds — the production `src/worker.tsx` includes
// the rwsdk router + auth handlers, none of which integration tests need.
//
// SyncedStateServer: the real rwsdk class (`rwsdk/use-synced-state/worker`)
// only exports under the `workerd` Vite condition, which the integration
// test build pipeline doesn't pick up through Vite's import-analysis phase.
// The stub below is sufficient for integration tests: it stores state in
// memory and exposes the same `setState`/`getState` RPC surface that
// `broadcastRunProgress` calls and the test assertions read back.
import { DurableObject } from "cloudflare:workers";

export class SyncedStateServer extends DurableObject {
  #store = new Map<string, unknown>();

  getState(key: string): Promise<unknown> {
    return Promise.resolve(this.#store.get(key));
  }

  setState(value: unknown, key: string): void {
    this.#store.set(key, value);
  }

  // Static no-ops — the real class uses these to wire up fan-out, which is
  // out of scope for ingest integration tests.
  static registerNamespace(_ns: unknown): void {}
  static registerRoomHandler(_h: unknown): void {}
}

export { TenantDO } from "@/tenant/tenant-do";
export { ControlDO } from "@/control/control-do";

// Workers require a default export with at least a `fetch` handler.
// Integration tests call the DO / control-DB layer directly, so this is a
// no-op used only to satisfy the runtime.
export default {
  async fetch(): Promise<Response> {
    return new Response("integration test worker", { status: 200 });
  },
};
