# 2026-05-22 — Audit-driven tightening of dashboard-void

Follow-up to `2026-05-22-void-migration-complete.md`. Audited the migration
against the canonical Void docs (`type-safety`, `database/d1`, `typed-fetch`,
`kv`, `storage`, `env-vars`, `auth`) via three parallel Explore agents.
The audit found **no BLOCKING issues** — every critical surface (auth
lifecycle, DB import shape, storage API, env validation, context-variable
augmentation, `InferProps` in every loader, `getSession`/`requireAuth` used
sync, no leftover KV) was already correct.

This worklog captures the STYLE-level fixes that close the doc gaps. The
OPTIMIZATIONs surfaced by the audit (#7–#11 below) are deferred — they're
purely additive.

## Changes

### Step A — Schema-derived validators on ingest routes

Refactored the four ingest handlers to use `defineHandler.withValidator({ body })`
instead of manual `XxxSchema.safeParse(await c.req.json())`. The validator
shape flows into `.void/routes.d.ts` so client-side `void/client#fetch` callers
see the same body type, and 400 responses now ship the doc's standard
`{ error, issues: [...] }` shape.

Files:

- `routes/api/runs/index.post.ts`
- `routes/api/runs/[id]/results.post.ts`
- `routes/api/runs/[id]/complete.post.ts`
- `routes/api/artifacts/register.post.ts`

`defineHandler.withValidator` returns a curry that only takes ONE handler —
the previous middleware chain (`requireApiKey, negotiateVersion, handler`)
doesn't fit. Added inline helper forms to `src/lib/api-auth.ts`:

- `requireApiKeyOrResponse(c): Promise<ApiKey | Response>` — returns the
  key on success, a 401 `Response` on failure; also sets `c.var.apiKey`
- `negotiateVersionOrResponse(c): Response | null`

The existing `requireApiKey` / `negotiateVersion` middleware exports
remain, now thin wrappers around the inline helpers — used by any route
that _doesn't_ need a validator.

### Step B — Query validator on the tests page

`pages/t/[teamSlug]/p/[projectSlug]/tests.server.ts` had manual
`url.searchParams.get(...)` parsing with a hand-rolled `parsePage` helper.
Replaced with `defineHandler.withValidator({ query: z.object({...}) })`.
The `parsePage` / `makeRangeParser` helpers are no longer imported; the
validator's `z.coerce.number().int().min(1).optional()` and
`z.enum(RANGES).optional()` cover both.

Knock-on: `Props` had to be re-typed as `Awaited<InferProps<typeof loader>>`
because `defineHandler.withValidator`'s `TypedHandler<V, R>` doesn't
auto-await `R` like the plain `defineHandler` overload does (see
`void/dist/handler-BPhL8AmU.d.mts` — the plain form wraps with
`Exclude<Awaited<R>, Response>` but `withValidator` doesn't). Inline
comment documents the workaround.

### Step C — Named actions on settings pages

Settings forms posted to the page URL with a hidden `<input name="action">`
field; the loader dispatched via `readField(form, "action")`. The doc
prescribes named actions per Void's pages-mode convention: one
`defineHandler` per concern, dispatched by an `?actionName` query suffix.

Refactored both settings pages with multi-action forms:

`pages/settings/teams/[teamSlug]/index.server.ts` —
`export const action = …` (one big switch) →
`export const actions = { updateGeneral, createInvite, revokeInvite, deleteTeam }`.

Common pre-flight (auth + owner role check) extracted into
`requireOwnerScope(c)` so each action stays under 30 lines.

`pages/settings/teams/[teamSlug]/p/[projectSlug]/keys.server.ts` — same
treatment with `{ createKey, revokeKey, updateGeneral, deleteProject }`.

`.tsx` updates: each `<form>` now has `action={`${here}?actionName`}` and
the hidden `<input type="hidden" name="action" …>` fields are removed.

This is the largest single fix in this pass — touches 4 files — but
unlocks typed `useForm` integration on follow-up work.

### Step D — Skipped (audit recommendation was wrong)

The audit suggested explicitly importing `R2Object` from
`@cloudflare/workers-types`. Tried it — TypeScript reported the module
unresolvable because the package isn't in our direct dependencies. The
type actually resolves via `/// <reference types="@cloudflare/workers-types" />`
inside `void/env`'s d.ts, which Void picks up via `tsconfig.json#types: ["void/env"]`.

Reverted to the implicit-global access and added an explanatory comment
in `routes/api/artifacts/[id]/download.ts`. Net result: no source change
from the original migration, plus a doc comment for future readers.

### Step E — Trimmed redundant `auth.providers`

`void.json` had `"auth": { "providers": ["email"] }` — the doc states
email/password is the default when the `auth` block is omitted but
`auth.ts` is present (which we have). Removed the `auth` block entirely.
GitHub OAuth registration stays conditional in `auth.ts` (added only when
`process.env.AUTH_GITHUB_CLIENT_ID` + `_SECRET` are set), so this change
is cosmetic and behavior is unchanged.

## Verification

```bash
cd packages/dashboard-void
pnpm exec void prepare       # ✓ codegen ok
pnpm exec tsc --noEmit       # 0 errors
pnpm exec vp check           # 0 errors, 76 warnings (no change vs prior worklog)
```

## OPTIMIZATIONs surfaced by the audit — deferred

These don't change behavior and aren't on the critical path. Capture for
future polish:

1. **`createInsertSchema` from `void/drizzle-zod`** — derive insert/update
   validators from the table shape instead of hand-writing Zod schemas in
   `src/lib/schemas.ts`. Our schemas encode richer constraints
   (per-attempt min counts, status enums) so the trade-off is real; defer.
2. **Drizzle `relations()`** — declare `relations()` on the schema for
   typed nested queries (`db.query.runs.findMany({ with: { testResults } })`).
   All current code uses explicit joins; not blocking.
3. **`userGithubAccounts` → Better Auth `additionalFields`** — the doc-canon
   way to extend the user schema is `additionalFields` on the auth config,
   not a sibling table. Migration would require wiping the existing
   `userGithubAccounts` and re-capturing logins on next sign-in; defer.
4. **Explicit `trustedOrigins`** — `auth.ts` relies on the default
   computed from `WRIGHTFUL_PUBLIC_URL`. Could set explicitly for
   self-documentation; behavior is identical.
5. **`void env check --remote` in CI** — pre-deploy validation that all
   declared env keys are set as remote secrets. Add when CI exists.
6. **`inference.bindings.kv: false`** in `void.json` — purely
   documentary; we don't import `void/kv` so inference skips KV anyway.
