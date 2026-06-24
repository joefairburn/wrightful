"use client";

import { EllipsisVertical } from "lucide-react";
import type React from "react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import type { QuarantineMode } from "@/lib/quarantine-schemas";

/**
 * The quarantine state surfaced per row on the flaky + tests-catalog pages:
 * a "Quarantined" badge when the test is on the list, plus — for OWNERS only —
 * a three-dot menu carrying the quarantine / release action. Non-owners see the
 * badge but no menu (the mutation is owner-gated server-side too; the UI just
 * doesn't offer it).
 *
 * The action is still a plain `<form>` POST to the shared session-authed
 * mutation route (`/api/t/:teamSlug/p/:projectSlug/quarantine`): the menu item
 * is its submit button, associated by `form={formId}` because Base UI portals
 * the menu popup out of this subtree. `redirectTo` brings the user back to the
 * page they acted from. The menu makes this a client island (Base UI needs JS),
 * unlike the otherwise-isomorphic catalog/flaky rows.
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
   * screen reader hears "Quarantine actions for <test>" rather than a list of
   * identical "Actions" buttons. Falls back to the testId when absent.
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
  const formId = useId();

  return (
    // `relative z-[1]` lifts the control above the row's stretched-link overlay
    // (`after:inset-0` on the row's `<Link>`), so the menu trigger stays
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
        <>
          {/* Hidden POST form — the menu item below is its submit button,
           * wired up via `form={formId}` since the popup is portaled out of
           * this subtree. `contents` keeps the empty form from adding a flex
           * gap between the badge and the trigger. */}
          <form
            action={actionPath}
            className="contents"
            id={formId}
            method="post"
          >
            <input
              name="intent"
              type="hidden"
              value={quarantined ? "unquarantine" : "quarantine"}
            />
            <input name="testId" type="hidden" value={testId} />
            {!quarantined && <input name="mode" type="hidden" value="skip" />}
            <input name="redirectTo" type="hidden" value={redirectTo} />
          </form>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`Quarantine actions for ${label}`}
                  size="icon-xs"
                  variant="ghost"
                >
                  <EllipsisVertical />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                render={
                  <button form={formId} type="submit">
                    {quarantined ? "Release from quarantine" : "Quarantine"}
                  </button>
                }
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
