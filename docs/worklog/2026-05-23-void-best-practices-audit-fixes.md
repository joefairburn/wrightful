# 2026-05-23 — `dashboard-void`: void best-practices audit fixes

## What changed

Acted on the six-part audit of `packages/dashboard-void/` against
`https://void.cloud/guide/*`. The audit was sourced from six parallel
sub-agents (pages-routing, layouts, loaders, middleware, type-safety/
typed-fetch, storage/config). This worklog covers all six fixes shipped in
one pass.

## 1. `void.json` — declare `auth.providers` explicitly

Previously the GitHub social provider was inferred at config-eval time from
`process.env.AUTH_GITHUB_CLIENT_ID/SECRET` in `auth.ts`. Now the intent is
declared up front:

```jsonc
"auth": { "providers": ["email", "github"] }
```

The conditional registration in `auth.ts` still gates the actual wiring on
credentials being present — leaving `void.json` declarative and `auth.ts`
runtime-honest about whether the button should render.

## 2. Root layout — drop auth duplication

`pages/layout.server.ts` was returning `{ auth }` even though
`middleware/01.context.ts` already populates `shared.auth` (and the layout
component was discarding the loader payload). Dropped the loader payload to
make middleware the single source of truth, leaving a `return {}` loader
with a doc comment explaining the contract.

## 3. Extract API-auth middleware (`middleware/02.api-auth.ts`)

Five route files were opening with an identical prologue:

```ts
const apiKeyOrResp = await requireApiKeyOrResponse(c);
if (apiKeyOrResp instanceof Response) return apiKeyOrResp;
const versionResp = negotiateVersionOrResponse(c);
if (versionResp) return versionResp;
```

Hoisted into a single global middleware that filters by path
(`/api/runs/*`, `/api/artifacts/register`, `/api/artifacts/:id/upload`).
Download remains token-authed and is explicitly excluded.

Handlers now read the resolved row via `getApiKey(c)`. The dead
`requireApiKey` / `negotiateVersion` middleware exports in
`src/lib/api-auth.ts` were pruned.

| Route                            | Before              | After        |
| -------------------------------- | ------------------- | ------------ |
| `POST /api/runs`                 | inline prologue × 4 | bare handler |
| `POST /api/runs/:id/results`     | inline prologue × 4 | bare handler |
| `POST /api/runs/:id/complete`    | inline prologue × 4 | bare handler |
| `POST /api/artifacts/register`   | inline prologue × 4 | bare handler |
| `PUT  /api/artifacts/:id/upload` | inline middleware   | bare handler |

## 4. Internal `<a href>` → `<Link>` sweep (26 sites)

Every internal navigation now uses `<Link>` from `@void/react` so SPA
transitions don't fall through to full document loads. External links
(`target="_blank"`, `https://`-scheme, and the deliberate OAuth full-page
redirect in `pages/login.tsx`) intentionally stay as `<a>`.

Touched 19 files across `pages/` and `src/components/`. Base UI `render={…}`
slots accept `<Link>` directly. `PopoverTrigger` in `run-history-bar-hover`
also swapped its hover-card trigger to a `Link`.

## 5. `/api/user/last-{team,project}` — kept as routes (not migrated)

The audit's recommendation was to migrate these to named page actions. On
inspection that would have been wrong: the switcher fires them
fire-and-forget right before `navigate(...)`. Per the void docs' "Choosing
a Primitive" table, `useForm` and `action()` both trigger Inertia page
updates, while `fetch()` is the documented choice "when you don't want
Inertia page updates." Page-action conversion would have round-tripped the
source view between click and navigation, which is the opposite of what the
switcher needs.

Added a comment block to each route explaining the rationale so the next
audit doesn't re-raise the same finding.

## 6. AppLayout → route-level layouts

Biggest change. Previously every interior page imported and wrapped itself
in `<AppLayout mode="…" backToAppHref={…}>`. Now there are two route
layouts that wrap subtrees automatically:

- `pages/settings/layout.tsx` → `<AppLayout mode="settings">`
- `pages/t/[teamSlug]/p/[projectSlug]/layout.tsx` → `<AppLayout mode="app">`

The team picker at `/t/[teamSlug]` deliberately stays standalone (no project
context = no sidebar nav), so the project layout is scoped one level deeper
than `pages/t/[teamSlug]/`.

### Shared data flow

`backToAppHref` was computed per-page in 5 identical `resolveBackToAppHref`
helpers. Consolidated into `src/lib/user-state.ts`, called once in
`middleware/01.context.ts` on `/settings/*` paths, and published on the
shared bundle. The settings sidebar reads it via `useShared()`.

### Page cleanup

- 14 pages lost their `<AppLayout>` wrapper. Several pages had multiple
  top-level JSX children so the returns are now wrapped in `<>…</>`.
- 5 settings loaders dropped both `backToAppHref` and the local
  `resolveBackToAppHref` helper (along with its now-unused imports of
  `getUserState`, `projects`, `teams`).
- `AppLayout` shed `backToAppHref` from its prop surface entirely; the
  settings sidebar reads it through `useShared`.

## Files

### New

- `middleware/02.api-auth.ts`
- `pages/settings/layout.tsx`
- `pages/t/[teamSlug]/p/[projectSlug]/layout.tsx`

### Modified — top-level

- `void.json` (auth.providers)
- `middleware/01.context.ts` (backToAppHref in shared bundle)
- `src/lib/user-state.ts` (added `resolveBackToAppHref`)
- `src/lib/api-auth.ts` (pruned dead middleware exports)
- `src/components/app-layout.tsx` (simpler prop surface, Link-only)
- `pages/layout.server.ts` (empty loader)

### Modified — internal Link migration

- `pages/index.tsx`, `pages/invite/[token]/index.tsx`,
  `pages/t/[teamSlug]/index.tsx`, plus 13 others across pages/ and
  src/components/ (26 internal `<a>` sites total)

### Modified — AppLayout unwrap

- 12 pages (all `/settings/**` and `/t/[teamSlug]/p/[projectSlug]/**`)
- 5 settings `.server.ts` loaders (dropped `backToAppHref` + helper)

### Modified — route handlers

- `routes/api/runs/index.ts`, `routes/api/runs/[id]/results.ts`,
  `routes/api/runs/[id]/complete.ts`, `routes/api/artifacts/register.ts`,
  `routes/api/artifacts/[id]/upload.ts`,
  `routes/api/user/last-team.ts`, `routes/api/user/last-project.ts`

## Verification

- `pnpm exec tsgo --noEmit` — exit 0
- `pnpm test` — 81 tests passed (6 files)
- `pnpm check` — 0 errors, 76 pre-existing warnings (`as string` lint
  rule in `auth.ts`, unrelated)
