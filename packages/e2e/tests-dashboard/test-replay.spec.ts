import { expect, test } from "./fixtures";
import { FAILURES_BRANCH } from "./global-setup";

/**
 * Embedded Test Replay — Wrightful's OWN trace viewer.
 *
 * The reporter uploads `trace.zip` per failed/flaky attempt. The dashboard
 * renders replays with its own React workbench (`src/trace-viewer/`) built on
 * the vendored Playwright service worker: a hidden bridge iframe under
 * `/trace-viewer/` loads the parsed model (`contexts?trace=…`), and DOM
 * snapshots render in iframes served by the SW
 * (`/trace-viewer/snapshot/<pageId>?trace=…`). The official viewer bundle
 * stays vendored as the engine + an "Official viewer" new-tab fallback.
 *
 * These specs prove: (1) the SW scope is served with the headers that make
 * registration + same-origin snapshot framing possible while the rest of the
 * app stays strict; (2) the per-row "Replay" button deep-links `?replay=` and
 * opens the native workbench with a REAL trace driven through the real SW —
 * action list populated, snapshot document served; (3) the test-detail rail
 * does the same. This doubles as the vendored-engine contract test: a
 * playwright-core bump that breaks the SW's `contexts`/`snapshot` endpoints
 * or the model shape fails here, not in production.
 *
 * The seed (`upload-fixtures.mjs`, reporter `artifacts: "all"` +
 * `trace: "retain-on-failure"`) gives the `FAILURES_BRANCH` run tests that
 * failed and therefore carry a trace — so the replay affordances render.
 */
test.describe("Test Replay (embedded trace viewer)", () => {
  test("serves the SW scope with same-origin framing; global routes stay strict", async ({
    page,
  }) => {
    // The vendored engine files our viewer depends on.
    for (const path of [
      "/trace-viewer/sw.bundle.js",
      "/trace-viewer/bridge.html",
      "/trace-viewer/index.html", // official-viewer fallback, still vendored
    ]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      const h = res.headers();
      // Relaxed only for /trace-viewer/* so snapshots can be framed and the
      // SW can register at the directory scope.
      expect(h["x-frame-options"]?.toLowerCase(), path).toBe("sameorigin");
      expect(h["content-security-policy"], path).toContain(
        "frame-ancestors 'self'",
      );
      expect(h["service-worker-allowed"], path).toBe("/trace-viewer/");
    }

    // Every other route keeps the strict global policy — the relaxation must
    // not leak. A normal page response still denies framing entirely.
    const normal = await page.request.get("/login");
    const nh = normal.headers();
    expect(nh["x-frame-options"]?.toLowerCase()).toBe("deny");
    expect(nh["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("run test-list Replay button opens the native workbench, deep-links, and closes on Escape", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto(`branch=${encodeURIComponent(FAILURES_BRANCH)}`);
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);

    // The button renders only for rows whose test has a trace (the row's
    // `hasTrace`, set by the `…/results` read); the failures run has at least one.
    const replay = page.getByRole("button", { name: /^replay$/i }).first();
    await expect(replay).toBeVisible({ timeout: 10_000 });

    // Clicking sets `?replay=<testResultId>`; the page-level host then fetches
    // the replay endpoint. The endpoint still hands back the SELF-HOSTED
    // official viewer URL (the "Official viewer" fallback link) plus the
    // downloadHref the native viewer feeds to the service worker.
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/replay") && r.request().method() === "GET",
      ),
      replay.click(),
    ]);
    expect(resp.ok()).toBe(true);
    const body: unknown = await resp.json();
    const traceViewerUrl =
      body && typeof body === "object" && "traceViewerUrl" in body
        ? body.traceViewerUrl
        : null;
    expect(typeof traceViewerUrl).toBe("string");
    expect(traceViewerUrl).toContain("/trace-viewer/index.html?trace=");
    expect(traceViewerUrl).not.toContain("trace.playwright.dev");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The NATIVE workbench loads the real trace through the real service
    // worker: the action list populates from the parsed model…
    const actionList = dialog.getByRole("listbox", { name: "Actions" });
    await expect(actionList).toBeVisible({ timeout: 30_000 });
    expect(await actionList.getByRole("option").count()).toBeGreaterThan(0);

    // …and the DOM snapshot iframes are served by the SW from the trace
    // (up to three stacked, one per Before/Action/After — see snapshot-pane).
    await expect(
      dialog.locator('iframe[title^="DOM snapshot"]').first(),
    ).toHaveAttribute("src", /\/trace-viewer\/snapshot\/.+\?.*trace=/, {
      timeout: 30_000,
    });

    // Parity-pass chrome renders alongside the workbench: the action search
    // box, the Call detail tab, and the timeline strip above the panes.
    await expect(
      dialog.getByRole("searchbox", { name: "Filter actions" }),
    ).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Call" })).toBeVisible();

    // Opening the modal is reflected in the URL (deep-linkable / shareable).
    await expect(page).toHaveURL(/[?&]replay=/);
    const deepLink = page.url();

    // Escape closes the modal and drops the param from the URL.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page).not.toHaveURL(/[?&]replay=/);

    // A cold load of the shared link re-opens the same modal (the host reads
    // the param and re-mints the trace URL), independent of any row being
    // expanded.
    await page.goto(deepLink);
    const relinked = page.getByRole("dialog");
    await expect(relinked).toBeVisible({ timeout: 10_000 });
    await expect(
      relinked.getByRole("listbox", { name: "Actions" }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("test-detail rail shows Replay (native viewer) alongside the standalone video/screenshot buttons", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto(`branch=${encodeURIComponent(FAILURES_BRANCH)}`);
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);

    // Navigate into a test KNOWN to have a trace: the row that carries the
    // list-level Replay button. Click its sibling detail link (SPA nav, so
    // the app stays hydrated and the rail's dialog trigger is interactive on
    // arrival — a full `goto` would race re-hydration). The run-detail row no
    // longer bounces back to the run page (see use-feed-room's navigation guard).
    const listReplay = page.getByRole("button", { name: /^replay$/i }).first();
    await expect(listReplay).toBeVisible({ timeout: 10_000 });
    const row = listReplay.locator("xpath=..");
    await row.locator('a[href*="/tests/"]').first().click();
    await page.waitForURL(/\/tests\//, { timeout: 15_000 });

    // Rail button renamed from "Trace Viewer" → "Replay".
    const railReplay = page.getByRole("button", { name: /^replay$/i });
    await expect(railReplay).toBeVisible({ timeout: 10_000 });

    // The standalone Video / Screenshot rail buttons are kept alongside Replay —
    // handy for grabbing a single asset without the whole trace.zip,
    // and the embedded viewer doesn't render the video anyway. The seed run
    // (reporter `artifacts: "all"`) carries both for a failed test.
    await expect(
      page.getByRole("button", { name: /^video$/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^screenshot$/i }).first(),
    ).toBeVisible();

    // Opening it renders the native workbench off the real trace.
    await railReplay.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("listbox", { name: "Actions" })).toBeVisible({
      timeout: 30_000,
    });
  });
});
