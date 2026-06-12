/**
 * Per-plan container policy for synthetic-monitor sandboxes. PURE (no `void/*`
 * imports) so it is unit-tested directly and importable from the otherwise
 * integration-only sandbox executor.
 *
 * Today this owns one knob — `sleepAfter`, the container idle timeout — but it
 * is the single place any "premium tenants get different container behavior"
 * policy should live.
 */

/**
 * The plan a monitor's container policy resolves under. There is no billing /
 * tier model yet (pre-launch), so the only member is `"default"`. When `teams`
 * gains a plan column, ADD members here, add their cases to
 * {@link SLEEP_AFTER_BY_PLAN}, and wire the lookup in {@link resolveMonitorPlan}.
 */
export type MonitorPlan = "default";

/** The plan used until a billing model exists — see {@link resolveMonitorPlan}. */
export const DEFAULT_MONITOR_PLAN: MonitorPlan = "default";

/**
 * Container idle timeout (`sleepAfter`) per plan, as a Sandbox-SDK duration
 * string ("45s" / "2m" / "1h" / a number of seconds).
 *
 * IMPORTANT — what this value actually controls: it ONLY bounds a *leaked*
 * container's idle billing. On every healthy run {@link runSandboxExecution}
 * tears the container down in its `finally`, so `sleepAfter` is never reached.
 * It matters only when that teardown never runs — the queue Worker was evicted
 * / CPU-killed mid-run, or `destroy()` itself failed. So SHORTER is strictly
 * cheaper-on-leak with no downside to a healthy run: the Sandbox SDK busy-polls
 * once per second and renews the container's activity deadline while an `exec`
 * is in flight, so a live check stays alive regardless of this value (the idle
 * countdown only starts once the process goes idle). The SDK's own default is
 * "10m" — i.e. a leaked container would bill ~10 idle minutes after a ~45s
 * check. `60s` keeps a safe margin over the 1s poll while cutting that ~10x.
 *
 * `Record<MonitorPlan, …>` makes adding a plan a compile error until its idle
 * timeout is set here, so a new tier can't silently inherit the wrong value.
 */
const SLEEP_AFTER_BY_PLAN: Record<MonitorPlan, string> = {
  default: "60s",
};

/** Resolve the container idle timeout for a plan. */
export function sandboxSleepAfter(plan: MonitorPlan): string {
  return SLEEP_AFTER_BY_PLAN[plan];
}

/**
 * The plan a monitor's container runs under. No billing model exists yet, so
 * every monitor resolves to {@link DEFAULT_MONITOR_PLAN}. The monitor carries
 * the trusted `teamId` the scheduler wrote, so when teams gain a plan column
 * this becomes a single indexed lookup here — the only call site changes.
 */
export function resolveMonitorPlan(_monitor: { teamId: string }): MonitorPlan {
  return DEFAULT_MONITOR_PLAN;
}
