/**
 * Test-only stand-in for the `cloudflare:workers` built-in module. It's a
 * workerd virtual module with no Node resolution, so under vitest (the void
 * plugin is disabled) modules that statically import from it — e.g.
 * `src/lib/email.ts` reading the `EMAIL` binding off `env` — would fail to
 * load. This stub exports an empty `env` so those imports resolve.
 *
 * Tests that need a binding present override this with
 * `vi.mock("cloudflare:workers", () => ({ env: { EMAIL: ... } }))`.
 */
export const env: Record<string, unknown> = {};
