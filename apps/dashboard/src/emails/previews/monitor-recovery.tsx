/**
 * Preview entry for `react-email`'s dev server (`pnpm email:dev`) — the
 * "recovery" monitor alert. Dev-only; relative import + sample props.
 * Downtime/failed-check counts are derived from execution history in production.
 */
import { MonitorAlert } from "../monitor-alert";

export default function MonitorRecoveryPreview() {
  return (
    <MonitorAlert
      downtime="35m 12s"
      failedChecks={7}
      intervalSeconds={300}
      kind="recovery"
      lastDurationMs={3600}
      monitorName="Checkout — reach payment"
      recoveredAt="Jun 15, 15:07 UTC"
      runUrl="https://app.example.com/t/acme/p/web/runs/preview-run"
      state="pass"
      teamName="Acme Engineering"
      url="https://app.example.com/t/acme/p/web/monitors/preview"
    />
  );
}
