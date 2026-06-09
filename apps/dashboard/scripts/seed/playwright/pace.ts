// Optional per-test pacing for the seed suite.
//
// `seed:stream` (scripts/seed-stream.mjs) sets SEED_DELAY_MS so a single run
// streams into the dashboard slowly enough to watch the rows, artifacts, and
// outcome tiles fill in live. `fixtures:generate` (bulk seeding) leaves it
// unset, so `pace()` is a no-op and seeding stays fast.
//
// Registered per spec file as `test.afterEach(pace)`. It must be called inside
// each spec — a shared `afterEach` in this module would only attach to the
// first spec that imports it (Node caches the module), so the hook lives in the
// specs and only the delay primitive is shared here.
const SEED_DELAY_MS = Number(process.env.SEED_DELAY_MS ?? "0");

export async function pace(): Promise<void> {
  if (SEED_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, SEED_DELAY_MS));
  }
}
