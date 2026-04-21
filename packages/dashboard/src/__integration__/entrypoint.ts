// Minimal worker entry for integration tests. Only exports what
// `wrangler.test.jsonc` binds — the production `src/worker.tsx` includes
// the rwsdk router + `SyncedStateServer` + auth handlers, none of which
// integration tests need. Keeping the test bundle small also sidesteps
// some of rwsdk's dev-server-flavoured resolve requirements.
export { TenantDO } from "@/tenant/tenant-do";

// Workers require a default export with at least a `fetch` handler.
// Integration tests call the DO / control-DB layer directly, so this is a
// no-op used only to satisfy the runtime.
export default {
  async fetch(): Promise<Response> {
    return new Response("integration test worker", { status: 200 });
  },
};
