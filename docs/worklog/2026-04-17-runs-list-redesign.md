# 2026-04-17 — Runs list redesign (phase 1)

## What changed

The runs list view got a visual overhaul based on a high-fidelity HTML prototype. Scope was deliberately narrow: retheme + relayout only, no new functional behaviour (filters, search, pagination are deferred).

### Layout

- New `ProjectShell` component at `packages/dashboard/src/app/components/project-shell.tsx` — left sidebar (project identity + nav: Runs active, Flaky Tests / Insights / Tests stubbed and visually disabled) + top header (project name, notifications/help/avatar icons).
- `runs-list.tsx` now renders inside the shell. Table grew a status-dot column, branch pill, commit-message column, and icon-prefixed test-count mini-pills (passed / failed / flaky / skipped). Footer shows row counts.

### Theme

- Retheme in place: `.dark` block in `src/app/styles.css` now uses a Material-ish dark surface scale (`#0e0e0e` / `#131313` / `#191a1a` / `#1f2020` / `#252626`) with `#c6c6c7` primary, `#19be64` success, `#ffd16f` warning, `#ee7d77` destructive, `#484848`-alpha borders. Kept the shadcn-style semantic token names (`--primary`, `--background`, etc.) so the 50 existing `ui/*` Base UI wrappers keep working unchanged.
- `html` element forced to `className="dark"` in `document.tsx`. Light mode is not in scope.
- Mono font swapped: `@fontsource/geist-mono` → `@fontsource-variable/jetbrains-mono`, and `--font-mono` updated to reference `"JetBrains Mono Variable"`.

### Dependency fix

- Downgraded `lucide-react` `^1.8.0` → `^0.469.0`. v1 adds `"use client"` directives to every icon file (including the shared `Icon.js`), which rwsdk's SSR "use client" module scanner fails to resolve — throws `No module found for '.../lucide-react/dist/esm/Icon.js' in module lookup for "use client" directive` on any render path that imports a lucide icon. API is identical between v0.469 and v1, so no call-site churn.

## Deliberate non-goals

- No new migration.
- No nuqs wiring. Search / Status / Branch / Pagination controls were considered but omitted — the prototype showed them and we'll add them in a follow-up.
- No shard handling in the UI (shard support was removed in `86e970e` on the same day — reports must be merged with `playwright merge-reports` before upload).
- No new `ui/*` primitives; no COSS scaffolds.

## Files touched

Modified:

- `packages/dashboard/package.json` — lucide downgrade, mono font swap
- `packages/dashboard/src/app/styles.css` — `.dark` palette, mono font import
- `packages/dashboard/src/app/document.tsx` — `className="dark"` on `<html>`
- `packages/dashboard/src/app/pages/runs-list.tsx` — rewritten render body, wrapped in `ProjectShell`

Added:

- `packages/dashboard/src/app/components/project-shell.tsx` — app shell
- `docs/worklog/2026-04-17-runs-list-redesign.md` — this entry

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — passes
- `pnpm lint` — passes (28 pre-existing warnings, 0 errors)
- `pnpm --filter @wrightful/dashboard dev` — boots in ~8.6s, no SSR errors, rwsdk directive scan completes
- Manual UI check in browser pending (report this is verified once you've clicked through `/t/:teamSlug/p/:projectSlug`)

## Follow-ups

- Wire Search, Status filter, Branch filter, Prev/Next via nuqs + server queries
- Real count pill (`select count(*) from runs where project_id = ?`) — currently shows displayed-rows count
- Factor `ProjectShell` + status-dot + test-count-pill out of `runs-list.tsx` as they're reused by sibling pages (run-detail, test-history, test-detail)
- Apply the shell to the other `/t/:teamSlug/p/:projectSlug/*` routes
