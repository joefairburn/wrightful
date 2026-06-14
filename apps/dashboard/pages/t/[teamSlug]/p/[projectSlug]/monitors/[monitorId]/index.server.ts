import type { Context } from "hono";
import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { env } from "void/env";
import { mutationErrorMessage } from "@/lib/action-errors";
import {
  CreateMonitorSchema,
  parseHttpMonitorConfig,
  parseTcpMonitorConfig,
  UpdateBrowserMonitorSchema,
  UpdateHttpMonitorSchema,
  UpdateTcpMonitorSchema,
} from "@/lib/monitors/monitor-schemas";
import {
  formType,
  httpConfigFromForm,
  tcpConfigFromForm,
} from "@/lib/monitors/monitor-form-parse";
import {
  httpResponseTimeBuckets,
  httpUptimeWindows,
} from "@/lib/monitors/http/uptime-analytics";
import {
  countMonitors,
  createMonitor,
  deleteMonitor,
  getMonitor,
  listExecutions,
  setMonitorEnabled,
  updateMonitor,
} from "@/lib/monitors/monitors-repo";
import {
  requireOwnerTenantContext,
  requireTenantContext,
} from "@/lib/tenant-context";
import { uptimeFromExecutions } from "../monitors-ui.shared";

export type Props = InferProps<typeof loader>;

const EXECUTIONS_LIMIT = 50;

/**
 * The `:monitorId` value reserved for the create form. `/monitors/new` resolves
 * to THIS route (not a sibling `new.tsx`) because Void's page matcher has no
 * static-over-dynamic precedence for routes nested under a dynamic segment: both
 * `/t/:teamSlug/p/:projectSlug/monitors/new` and `…/monitors/:monitorId` contain
 * params, so the tie-break is `localeCompare`, where `:monitorId` sorts before
 * `new` and shadows it (see `scan-2YmJkYAf.mjs`). Rather than relocate the detail
 * URL, this route owns the `new` sentinel and serves the create form for it.
 * Monitor ids are ULIDs, so a real monitor can never collide with `"new"`.
 */
const CREATE_SENTINEL = "new";

/** Read the active monitor id from the route, 404 if absent. */
function requireMonitorId(c: Context): string {
  const monitorId = c.req.param("monitorId");
  if (!monitorId) throw new Response("Not Found", { status: 404 });
  return monitorId;
}

/**
 * Loader for the monitor detail page AND the create form (`/monitors/new`).
 *
 * `monitorId === "new"` → create mode: returns just the project + any
 * `?formError`. Otherwise detail mode: resolves the monitor + its recent
 * executions in scope (a monitor not in scope 404s without leaking existence —
 * `getMonitor` returns null for missing and cross-tenant alike). The returned
 * shape is a `mode`-discriminated union the page switches on.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);
  const monitorId = requireMonitorId(c);
  const url = new URL(c.req.url);
  const projectProps = {
    slug: project.slug,
    name: project.name,
    teamSlug: project.teamSlug,
    role: project.role,
  };

  if (monitorId === CREATE_SENTINEL) {
    // Authoring a monitor is owner-only (it mints a per-run ingest key + runs
    // user code server-side). Non-owners can view monitors but not the create
    // form — 404 it, mirroring the action gate + the settings owner seam.
    if (project.role !== "owner")
      throw new Response("Not Found", { status: 404 });
    return {
      mode: "create" as const,
      project: projectProps,
      // Which create form to show: `?type=http` → uptime form, `?type=tcp` →
      // TCP form, `?type=browser` → browser form, absent → the type chooser.
      type: url.searchParams.get("type"),
      formError: url.searchParams.get("formError"),
    };
  }

  const monitor = await getMonitor(scope, monitorId);
  if (!monitor) throw new Response("Not Found", { status: 404 });

  const executions = await listExecutions(scope, monitorId, EXECUTIONS_LIMIT);

  // HTTP monitors carry inline config + their own analytics (SQL-computed,
  // time-based uptime + a response-time trend). TCP monitors carry inline config
  // too, and reuse the SAME time-based uptime windows (a tcp execution settles to
  // the same pass/fail states), but have no response-time-vs-status trend — a tcp
  // check has no status code. Browser monitors carry none of these (their detail
  // lives in the linked run reports).
  const isHttp = monitor.type === "http";
  const isTcp = monitor.type === "tcp" || monitor.type === "ping";
  const httpConfig = isHttp ? parseHttpMonitorConfig(monitor.config) : null;
  const tcpConfig = isTcp ? parseTcpMonitorConfig(monitor.config) : null;

  let uptimeWindows: {
    d1: number | null;
    d7: number | null;
    d30: number | null;
  } | null = null;
  let responseTrend: Array<{
    key: string;
    label: string;
    p50: number | null;
    p95: number | null;
  }> | null = null;

  // Both http AND tcp settle to the same pass/degraded/fail/error states, so the
  // time-based uptime windows (`httpUptimeWindows`, which keys off `state`, not
  // any http-only column) serve both. The response-time TREND is http-only: it
  // requires `statusCode is not null`, and a tcp check has no status code — so
  // tcp gets the uptime windows but no trend chart.
  if (isHttp || isTcp) {
    const nowSec = Math.floor(Date.now() / 1000);
    const windows = await httpUptimeWindows({ scope, monitorId, nowSec });
    uptimeWindows = {
      d1: windowPct(windows.d1),
      d7: windowPct(windows.d7),
      d30: windowPct(windows.d30),
    };

    if (isHttp) {
      // 24 hourly slots ending at the current hour.
      const nowHour = Math.floor(nowSec / 3600);
      const windowStartSec = (nowHour - 23) * 3600;
      const rows = await httpResponseTimeBuckets({
        scope,
        monitorId,
        windowStartSec,
      });
      // left-join the SQL rows onto the continuous skeleton so empty hours render
      // as gaps in the chart.
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      responseTrend = Array.from({ length: 24 }, (_, i) => {
        const slot = nowHour - 23 + i;
        const r = byBucket.get(slot);
        const hour = new Date(slot * 3600 * 1000).getUTCHours();
        return {
          key: String(slot),
          label: `${String(hour).padStart(2, "0")}:00`,
          p50: r?.p50 ?? null,
          p95: r?.p95 ?? null,
        };
      });
    }
  }

  return {
    mode: "detail" as const,
    project: projectProps,
    monitor,
    executions,
    httpConfig,
    // Parsed tcp host/port/timeout config for tcp/ping; null otherwise.
    tcpConfig,
    // Real time-based uptime (24h/7d/30d) for http + tcp; null for browser
    // (which uses the count-based `uptime` below). Each is a % or null when
    // nothing countable yet.
    uptimeWindows,
    // 24-slot hourly response-time trend (p50/p95) for http; null for tcp/browser.
    responseTrend,
    // Count-based uptime over the loaded window (null until there's something
    // countable). The page colors it by the same >99 / >95 thresholds as the
    // design's meta row.
    uptime: uptimeFromExecutions(executions),
    // `nextRunAt` (epoch seconds, null when paused / never armed) lives on the
    // monitor row — the page renders it for enabled monitors and "paused"/
    // "queued" otherwise.
    nextRunAt: monitor.nextRunAt,
    // Whether the edit form is open. Toggled via `?edit=1` so the section is
    // server-rendered (no client island) and survives a no-JS round trip.
    editing: url.searchParams.get("edit") === "1",
    formError: url.searchParams.get("formError"),
    dangerError: url.searchParams.get("dangerError"),
  };
});

/** A window's up/countable counts → uptime %, or null when nothing countable. */
function windowPct(w: { up: number; countable: number }): number | null {
  return w.countable > 0 ? (w.up / w.countable) * 100 : null;
}

/**
 * Create + detail mutations. `createMonitor` backs `/monitors/new?createMonitor`;
 * the rest back the detail page's edit / pause / delete. All reuse the repo's
 * scoped functions — a monitor outside the tenant resolves to null / a no-op
 * cleanly (no existence leak). The repo re-arms `nextRunAt` when interval/enabled
 * change so the schedule can't strand.
 */
export const actions = {
  /**
   * Create a monitor (the `/monitors/new` form posts here). Enforces the
   * per-project cap before insert (the unique `(projectId, name)` index is the
   * race-proof guard); re-renders the create form via `?formError=` on a cap
   * hit, invalid form, or duplicate name; redirects to the new monitor's detail.
   */
  createMonitor: defineHandler(async (c) => {
    const user = requireAuth(c);
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorsBase = `/t/${project.teamSlug}/p/${project.slug}/monitors`;
    const form = await c.req.formData();
    const type = formType(form);
    // Keep the chosen type on the redirect so the create form re-renders the
    // right variant (browser vs uptime) with the error.
    const fail = (msg: string) =>
      c.redirect(
        `${monitorsBase}/new?type=${type}&formError=${encodeURIComponent(msg)}`,
      );

    // Browser, http, and tcp have SEPARATE per-project caps (a container run vs
    // a plain fetch vs a raw socket connect); count + limit by the chosen type so
    // they don't interfere.
    const cap =
      type === "http"
        ? env.WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT
        : type === "tcp"
          ? env.WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT
          : env.WRIGHTFUL_MONITOR_MAX_PER_PROJECT;
    const count = await countMonitors(scope, type);
    if (count >= cap) {
      const kind =
        type === "http" ? "uptime" : type === "tcp" ? "TCP" : "browser";
      return fail(
        `This project has reached its limit of ${cap} ${kind} monitors. Delete one before creating another.`,
      );
    }

    const parsed = CreateMonitorSchema.safeParse(
      type === "http"
        ? {
            type,
            name: form.get("name"),
            intervalSeconds: form.get("intervalSeconds"),
            enabled: form.get("enabled") ?? "",
            config: httpConfigFromForm(form),
          }
        : type === "tcp"
          ? {
              type,
              name: form.get("name"),
              intervalSeconds: form.get("intervalSeconds"),
              enabled: form.get("enabled") ?? "",
              config: tcpConfigFromForm(form),
            }
          : {
              type,
              name: form.get("name"),
              source: form.get("source"),
              intervalSeconds: form.get("intervalSeconds"),
              // A paused switch omits the field. Coalesce `null` → `""` (not
              // `undefined`): `checkboxBoolean` maps a non-"on" string to
              // `false`, whereas `undefined` would trigger `.default(true)`.
              enabled: form.get("enabled") ?? "",
            },
    );
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Invalid monitor.");
    }

    const now = Math.floor(Date.now() / 1000);
    let monitorId: string;
    try {
      const monitor = await createMonitor(scope, parsed.data, user.id, now);
      monitorId = monitor.id;
    } catch (err) {
      return fail(
        mutationErrorMessage(err, {
          context: "create monitor failed",
          uniqueMessage: "A monitor with that name already exists.",
          genericMessage: "Could not create monitor — please try again.",
        }),
      );
    }

    return c.redirect(`${monitorsBase}/${monitorId}`);
  }),

  /** Apply an edit. Re-renders with `?formError=` on invalid form / dup name. */
  updateMonitor: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);
    const here = `/t/${project.teamSlug}/p/${project.slug}/monitors/${monitorId}`;
    // Keep the editor open (`edit=1`) on a validation error so the surfaced
    // `formError` lands beside the form the user was filling in.
    const fail = (msg: string) =>
      c.redirect(`${here}?edit=1&formError=${encodeURIComponent(msg)}`);

    // `type` is immutable — dispatch on the EXISTING monitor's type, not the
    // posted one, and pick the matching update schema (a discriminated union
    // can't be `.partial()`-ed, so the schemas are per-type).
    const existing = await getMonitor(scope, monitorId);
    if (!existing) throw new Response("Not Found", { status: 404 });

    const form = await c.req.formData();
    const parsed =
      existing.type === "http"
        ? UpdateHttpMonitorSchema.safeParse({
            name: form.get("name") ?? undefined,
            intervalSeconds: form.get("intervalSeconds") ?? undefined,
            enabled: form.get("enabled") ?? "",
            config: httpConfigFromForm(form),
          })
        : existing.type === "tcp" || existing.type === "ping"
          ? UpdateTcpMonitorSchema.safeParse({
              name: form.get("name") ?? undefined,
              intervalSeconds: form.get("intervalSeconds") ?? undefined,
              enabled: form.get("enabled") ?? "",
              config: tcpConfigFromForm(form),
            })
          : UpdateBrowserMonitorSchema.safeParse({
              name: form.get("name") ?? undefined,
              source: form.get("source") ?? undefined,
              intervalSeconds: form.get("intervalSeconds") ?? undefined,
              // The edit form always submits the switch state (an absent value
              // means "unchecked"), so coerce undefined → false rather than
              // leaving enabled untouched — matches the visible toggle.
              enabled: form.get("enabled") ?? "",
            });
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Invalid monitor.");
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      const updated = await updateMonitor(
        scope,
        monitorId,
        parsed.data,
        now,
        existing,
      );
      if (!updated) throw new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof Response) throw err;
      return fail(
        mutationErrorMessage(err, {
          context: "update monitor failed",
          uniqueMessage: "A monitor with that name already exists.",
          genericMessage: "Could not save changes — please try again.",
        }),
      );
    }

    return c.redirect(here);
  }),

  /** Pause / resume. Reads the desired state from a hidden `enabled` field. */
  toggleEnabled: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);
    const here = `/t/${project.teamSlug}/p/${project.slug}/monitors/${monitorId}`;

    const form = await c.req.formData();
    const enabled = form.get("enabled") === "true";
    const now = Math.floor(Date.now() / 1000);
    await setMonitorEnabled(scope, monitorId, enabled, now);

    return c.redirect(here);
  }),

  /** Delete the monitor + its execution history, then back to the list. */
  deleteMonitor: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);

    await deleteMonitor(scope, monitorId);

    return c.redirect(`/t/${project.teamSlug}/p/${project.slug}/monitors`);
  }),
};
