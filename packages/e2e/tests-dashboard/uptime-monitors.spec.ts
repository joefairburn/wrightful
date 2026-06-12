import { triggerScheduled } from "./helpers/dev-trigger";
import { expect, test } from "./fixtures";

/**
 * HTTP (uptime) monitoring UI + scheduler smoke test — the uptime sibling of
 * `monitors.spec.ts`.
 *
 * Unlike browser monitors there is NO stub executor: an http check is a plain
 * `fetch`, so it runs identically in dev/CI/prod. The monitor must target a
 * PUBLIC URL — the `url-policy` SSRF guard rejects loopback/localhost at the
 * form, so we can't point it at the dashboard's own dev URL. We use a stable
 * public host and drive one scheduled cycle via Void's dev triggers. The check's
 * outcome is deliberately not pinned (see below), so the test passes whether or
 * not the CI worker has outbound egress: a blocked/failed fetch is still recorded
 * as a terminal `fail` execution, which is all the pipeline assertion needs:
 *
 *   1. Create an http monitor through the form; assert it lands in the list with
 *      the "uptime" type pill + interval, and its detail shows the request
 *      config summary (no code editor).
 *   2. Fire the `sweep-monitors` cron until the monitor is due. The sweep routes
 *      the job to `queues/uptime.ts` (not `monitors`), whose consumer runs the
 *      real `fetch` and records the result inline on `monitorExecutions` — NO
 *      `runs` row. Assert an execution lands and that the row deep-links to NO
 *      run report (the http-vs-browser differentiator), exposing a status code
 *      instead.
 *
 * The assertion deliberately doesn't pin pass-vs-fail: whatever the dashboard's
 * root returns (200 / a redirect / an error), a terminal execution is recorded —
 * the point is the uptime PIPELINE (route → fetch → inline result), not the
 * target's status.
 */

const SWEEP_CRON = "* * * * *";
const ONE_MINUTE = 60;
// A public target — `url-policy` rejects loopback/localhost, so the monitor
// can't point at the dashboard's own dev URL. The pipeline assertion is
// status-agnostic, so this passes even if CI egress can't reach the host (a
// failed fetch records a terminal `fail`).
const TARGET_URL = "https://example.com";

test.setTimeout(150_000);

test.describe("HTTP uptime monitors", () => {
  test("create an uptime check, schedule one cycle, record an inline result", async ({
    monitorsPage,
    page,
    ctx,
  }) => {
    const name = `pw-uptime-${Date.now()}`;

    // 1. Create via the http form (pointed at a public URL — url-policy blocks
    // loopback, so the dashboard's own dev URL can't be the target).
    await monitorsPage.gotoNewHttp();
    const monitorId = await monitorsPage.createHttp({
      name,
      intervalSeconds: ONE_MINUTE,
      url: TARGET_URL,
    });

    // List: the uptime type pill + humanized interval.
    await monitorsPage.gotoList();
    const row = monitorsPage.listRowFor(name);
    await expect(row).toBeVisible();
    await expect(row.getByText(/^uptime$/)).toBeVisible();
    await expect(row.getByText(/^1m$/)).toBeVisible();

    // Detail: the request config summary (a GET chip), not a code editor, and
    // no executions yet.
    await monitorsPage.gotoDetail(monitorId);
    await expect(page.getByText(/^GET$/)).toBeVisible();
    await expect(monitorsPage.emptyExecutions).toBeVisible();

    // 2. Sweep until the monitor is due and the uptime consumer records a
    // result. Each tick is a no-op until `nextRunAt` passes.
    await expect(async () => {
      await triggerScheduled(
        page.request,
        ctx.url,
        ctx.devTriggerToken,
        SWEEP_CRON,
      );
      await monitorsPage.gotoDetail(monitorId);
      await expect(monitorsPage.emptyExecutions).toBeHidden({ timeout: 5_000 });
    }).toPass({ timeout: 130_000 });

    // An http execution carries an inline result — NOT a run report. The
    // "View run" deep-link must never appear for an uptime check.
    await expect(monitorsPage.runLinks).toHaveCount(0);
    // The execution row surfaces a result state badge (pass / degraded / fail).
    await expect(
      page.getByText(/^(pass|degraded|fail|error)$/i).first(),
    ).toBeVisible();
  });
});
