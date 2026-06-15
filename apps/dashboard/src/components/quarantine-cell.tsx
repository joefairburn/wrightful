import type React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { QuarantineMode } from "@/lib/quarantine-schemas";

/**
 * The quarantine state surfaced per row on the flaky + tests-catalog pages:
 * a "Quarantined" badge when the test is on the list, plus — for OWNERS only —
 * a quarantine / unquarantine control. Non-owners see the badge but no control
 * (the mutation is owner-gated server-side too; the UI just doesn't offer it).
 *
 * The control is a plain `<form>` POST to the shared session-authed mutation
 * route (`/api/t/:teamSlug/p/:projectSlug/quarantine`), so it works without JS
 * and matches how the catalog/flaky pages stay isomorphic (no per-row island).
 * The submit goes through the `ui/button` wrapper (same as every other
 * POST-form control, e.g. members.tsx) so it inherits the design system's
 * focus-visible ring, hover, and disabled tokens. `redirectTo` brings the user
 * back to the page they acted from.
 */

export interface QuarantineState {
  mode: QuarantineMode;
  reason: string | null;
}

export interface QuarantineCellProps {
  /** `/api/t/:teamSlug/p/:projectSlug/quarantine`. */
  actionPath: string;
  /** Where to return after the mutation — the current page URL+query. */
  redirectTo: string;
  testId: string;
  /**
   * Human-readable test title, used to build per-row accessible labels so a
   * screen reader hears "Quarantine <test>" rather than a list of identical
   * "Quarantine" buttons. Falls back to the testId when absent.
   */
  title?: string;
  /** Non-null when this test is currently quarantined. */
  quarantine: QuarantineState | null;
  /** Only owners get the mutating control; everyone sees the badge. */
  canManage: boolean;
}

export function QuarantineCell({
  actionPath,
  redirectTo,
  testId,
  title,
  quarantine,
  canManage,
}: QuarantineCellProps): React.ReactElement {
  const quarantined = quarantine !== null;
  const label = title ?? testId;

  return (
    // `relative z-[1]` lifts the control above the row's stretched-link overlay
    // (`after:inset-0` on the row's `<Link>`), so the form button stays
    // clickable instead of being captured by the row-wide navigation target.
    <div className="relative z-[1] flex items-center justify-end gap-2">
      {quarantine && (
        // The reason rides on `aria-label` (not just `title`, which AT doesn't
        // reliably announce) so it's reachable without a pointer.
        <Badge
          aria-label={
            quarantine.reason
              ? `Quarantined: ${quarantine.reason}`
              : "Quarantined"
          }
          size="sm"
          title={quarantine.reason ?? "Quarantined"}
          variant="warning"
        >
          Quarantined
        </Badge>
      )}
      {canManage && (
        <form action={actionPath} method="post">
          <input
            name="intent"
            type="hidden"
            value={quarantined ? "unquarantine" : "quarantine"}
          />
          <input name="testId" type="hidden" value={testId} />
          {!quarantined && <input name="mode" type="hidden" value="skip" />}
          <input name="redirectTo" type="hidden" value={redirectTo} />
          <Button
            aria-label={
              quarantined
                ? `Release ${label} from quarantine`
                : `Quarantine ${label}`
            }
            size="xs"
            type="submit"
            variant="outline"
          >
            {quarantined ? "Release" : "Quarantine"}
          </Button>
        </form>
      )}
    </div>
  );
}
