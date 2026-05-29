# 2026-05-25 — dashboard-void: extract duplicated settings-loader helpers

## What changed

The in-flight settings redesign in `packages/dashboard-void/pages/settings/teams/[teamSlug]/...` had grown three near-identical local helpers across sibling `.server.ts` files:

- `requireOwnerScope(c)` defined in both `general.server.ts` and `members.server.ts`
- `requireOwnedProject(c)` + `requireProjectScope(c)` in `keys.server.ts`
- `redirectWithParam(c, base, key, value)` in both `general.server.ts` and `keys.server.ts`
- `SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/` + the matching error string repeated verbatim in both server files
- `initials(name: string)` defined in both `src/components/sidebar-user-menu.tsx` and `pages/settings/teams/[teamSlug]/members.tsx`

Pulled them into three shared modules before the redesign lands and the duplication multiplies as more settings pages are added.

## Details

New modules in `packages/dashboard-void/src/lib/`:

| File                | Exports                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `slug.ts`           | `SLUG_RE`, `SLUG_ERROR`, `isValidSlug()`                                                                                           |
| `initials.ts`       | `initials(name)`                                                                                                                   |
| `settings-scope.ts` | `redirectWithParam()`, `requireOwnerScope(c, hereFor)`, `requireOwnedProjectScope(c, hereFor)`, types `OwnedTeam` / `OwnedProject` |

The scope helpers take a `hereFor` builder so each call site declares its own redirect-back URL at the top of the file (kept readable, just deduped). The owner-scope helpers still wrap their `requireTeamOwner` / `resolveProjectBySlugs` call in a try/catch that throws `404` instead of `403`, preserving the existing "don't leak existence to non-owners" behaviour.

## Files modified

- `pages/settings/teams/[teamSlug]/general.server.ts` — dropped local `SLUG_RE`, `redirectWithParam`, `requireOwnerScope`; imports from `settings-scope` + `slug`.
- `pages/settings/teams/[teamSlug]/members.server.ts` — dropped local `requireOwnerScope`; imports from `settings-scope`.
- `pages/settings/teams/[teamSlug]/members.tsx` — dropped local `initials`; imports from `lib/initials`.
- `pages/settings/teams/[teamSlug]/p/[projectSlug]/keys.server.ts` — dropped local `SLUG_RE`, `redirectWithParam`, `ProjectScope`, `requireOwnedProject`, `requireProjectScope`; imports from `settings-scope` + `slug`. The loader explicitly trims `OwnedProject` back to the pre-refactor shape (omitting `role`) so the `InferProps<typeof loader>` contract with `keys.tsx` stays identical.
- `src/components/sidebar-user-menu.tsx` — dropped local `initials`; imports from `lib/initials`.

## Out of scope (noted for later)

- Settings loaders still re-resolve the team independently of `middleware/01.context.ts`'s tenant bundle. Reusing the bundle would change behaviour (the bundle isn't owner-only), so left for a follow-up.
- No Zod schemas introduced — settings forms still use `readField` + inline validation, matching the rest of the package.
- `safe-next-path.ts` carries an unrelated `no-control-regex` lint error that already exists on the in-flight branch.

## Verification

- `pnpm --filter @wrightful/dashboard-void check` — same baseline as before the refactor: 1 pre-existing error (`safe-next-path.ts:5`, unrelated to this change) + 72 pre-existing warnings.
- `pnpm --filter @wrightful/dashboard-void test` — 92/92 passing.
- Manual smoke not run (planned: `/settings/teams/<slug>/general` rename + bad-slug error, `/settings/teams/<slug>/members` revoke invite, `/settings/teams/<slug>/p/<project>/keys` rename + revoke + delete-with-confirm, sidebar initials, member-row initials).
