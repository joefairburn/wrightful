/**
 * Preview entry for `react-email`'s dev server (`pnpm email:dev`) — the "down"
 * monitor alert. Dev-only; relative import + sample props. Last-passed + the
 * run link are optional in production and dropped from the table when absent.
 */
import { MonitorAlert } from "../monitor-alert";

export default function MonitorDownPreview() {
  return (
    <MonitorAlert
      errorMessage={`TimeoutError: expect(locator).toBeVisible()
Locator: getByTestId('payment-form')
Expected: visible
Timeout: 8000ms exceeded
  at checkout.spec.ts:12:48`}
      intervalSeconds={300}
      kind="down"
      lastPassedAt="Jun 15, 14:32 UTC"
      monitorName="Checkout — reach payment"
      runUrl="https://app.example.com/t/acme/p/web/runs/preview-run"
      state="fail"
      teamName="Acme Engineering"
      url="https://app.example.com/t/acme/p/web/monitors/preview"
    />
  );
}
