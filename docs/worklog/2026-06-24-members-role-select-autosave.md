# 2026-06-24 — Members role pickers: custom `ui/select` + autosave

## What changed

The Settings → Team → Members page used native `<select>` elements for its two
role pickers (the "Invite a teammate" role and the per-member role). Both were
switched to the local Base UI `ui/select` component, and the per-member picker
now **autosaves on change** — the "Save" button is gone.

Previously the per-member role lived inside a no-JS `<form method="post">` that
POSTed to the `updateMemberRole` server action and full-page-redirected. The
native selects were a deliberate no-JS choice (the page's remove / leave /
revoke controls are still plain form posts). Switching to the JS-only Base UI
select means the role change is now JS-driven, so it moves to a client API call
instead of a form post — the other no-JS controls are unchanged.

## Details

| File                                                  | Change                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/api/teams/[teamSlug]/members.ts`              | **New.** `PATCH /api/teams/:teamSlug/members` — owner-only JSON endpoint that changes one member's role. Mirrors the sibling `invites.ts`: `resolveOwnedTeam` gate, `readBodyField` for `userId`/`role`, `roleSchema` validation, and the **shared `setMemberRole` last-owner guard + `MEMBER_ROLE_CHANGE` audit**. Returns `{ role }`, or `409` (last-owner) / `404` (member gone) / `400` (bad role) with an `error` message. |
| `pages/settings/teams/[teamSlug]/members.tsx`         | Both native `<select>`s → `ui/select` (`Select`/`SelectTrigger`/`SelectValue`/`SelectPopup`/`SelectItem`). New `MemberRoleSelect` island: optimistic value, PATCHes the endpoint on change, `router.refresh()` on success, reverts + surfaces the error on failure. Added a page-level `roleError` state shown in the existing error `Alert` (takes precedence over the loader's `membersError`). Removed the now-unused `roleSelectClassName`. |
| `pages/settings/teams/[teamSlug]/members.server.ts`   | Removed the dead `updateMemberRole` action (replaced by the route) and pruned its now-unused `roleSchema` / `setMemberRole` imports. Updated the loader doc comment to note role changes are now client-API-driven. The shared `setMemberRole` in `members-repo` is untouched (now called from the route). |

The last-owner invariant is unchanged: it still rides inside `setMemberRole`'s
guarded UPDATE (owner-count subquery in the WHERE), so demoting the sole owner
matches 0 rows and surfaces as a `lastOwner` error — now a `409` JSON body
instead of a redirect with `?membersError=`.

## Verification

- `pnpm check` (format + lint + type-check via `vp check`) — **0 errors**; the
  three changed files carry **zero diagnostics** and add **no** new warnings
  (warning count back at the repo baseline after typing the `SelectValue`
  render callback as `(v: string)` instead of `v as string`).
- `pnpm --filter @wrightful/dashboard exec vp test run -c vitest.workers.config.ts members-repo`
  — **13 passed** (the `setMemberRole` / guarded-write contract is unchanged).
- No e2e/unit test drove the removed `updateMemberRole` form or its Save button
  (`groups.spec.ts` covers member *groups*, a different surface).
