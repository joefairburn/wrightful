# 2026-04-18 — Lint cleanup: eliminate oxlint warnings

## What changed

Cleared the 31 oxlint warnings the repo accumulated (no-shadow + no-unsafe-type-assertion). After the pass, `pnpm lint` reports 0 warnings / 0 errors. `pnpm typecheck`, `pnpm test`, and `pnpm format` all pass.

## Details

### `eslint(no-shadow)` — renamed inner bindings

Removed five shadowed-variable warnings by renaming the inner binding:

| File                                                    | Change                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/app/components/ui/calendar.tsx` | inner `Chevron` component's `className` / `...props` → `chevronClassName` / `...chevronProps` |
| `packages/dashboard/src/app/components/ui/checkbox.tsx` | `render` callback's `props` → `indicatorProps`                                                |
| `packages/dashboard/src/app/components/ui/sidebar.tsx`  | `toggleSidebar`'s setter callbacks `(open) => !open` → `(prev) => !prev`                      |

### `typescript-eslint(no-unsafe-type-assertion)` — type guards, context typing, or documented disables

Real fixes (type guards / proper typing):

- **`packages/dashboard/src/lib/better-auth.ts`** — extracted `getGithubOAuthCreds()` helper that narrows `env.GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` from `string | undefined` to `string`, so the `as string` casts are no longer needed.
- **`packages/dashboard/src/lib/status.ts`** — added `isStatus()` type guard; `statusColor()` now branches on it instead of `status as Status`.
- **`packages/dashboard/src/lib/hooks/use-media-query.ts`** — added `isBreakpoint()` type guard; `parseQuery()` uses it instead of `segment as Breakpoint`.
- **`packages/dashboard/src/routes/middleware.ts`** — `requireUser` now forwards its args object to `loadSession` directly, dropping the `as Parameters<RouteMiddleware>[0]` cast.
- **`packages/dashboard/src/app/pages/login-form.tsx`** — replaced `form.elements.namedItem("email") as HTMLInputElement` with a `FormData`-based helper that runtime-checks `typeof v === "string"`.
- **`packages/dashboard/src/app/pages/test-history.tsx`** + **`packages/dashboard/src/app/components/sparkline.tsx`** — widened `SparklinePoint.status` from `Status` to `string` (the component already delegates to `statusColor()`, which falls back for unknown strings). The cast at the call-site is no longer needed.
- **`packages/dashboard/src/app/components/ui/combobox.tsx`** — changed `ComboboxContext.chipsRef` from `RefObject<Element | null>` to `RefObject<HTMLDivElement | null>`; drops the `ref={chipsRef as React.Ref<HTMLDivElement> | null}` cast.
- **`packages/dashboard/src/app/components/ui/input-group.tsx`** — replaced `e.target as HTMLElement` with an `instanceof Element` guard.
- **`packages/dashboard/src/app/components/ui/toast.tsx`** — added `isToastIconKey()` type guard + `getTooltipStyle(data: unknown)` using `in`-operator narrowing.
- **`packages/dashboard/src/app/components/ui/calendar.tsx`** — replaced the `reduce((acc, key) => …)` merge over `Object.keys(defaultClassNames)` with a typed `for…of` using a single disable-directive-annotated `as ClassNameKey[]` cast on the key list.
- **`packages/e2e/vitest.globalSetup.ts`** — validated the JSON sign-up response with explicit `typeof`/`in` checks before reading `body.user.id`; no cast.

Documented intentional casts with inline `// oxlint-disable-next-line` + a reason (these are real TS expressiveness gaps, not code smells):

- `packages/dashboard/src/app/components/ui/calendar.tsx` — `Object.keys(defaultClassNames) as ClassNameKey[]` (key type erased by `Object.keys`) and `dayPickerProps as React.ComponentProps<typeof DayPicker>` (discriminated-union on `mode` can't be constructed generically).
- `packages/dashboard/src/app/components/ui/sidebar.tsx` — two `style={… as React.CSSProperties}` sites that declare CSS custom properties (not modelled by `CSSProperties`) and one `buttonElement as React.ReactElement<Record<string, unknown>>` where `useRender`'s return type is looser than `TooltipTrigger` accepts.
- `packages/cli/src/lib/api-client.ts` — three casts: protocol-contract cast for `body.uploads`, `Readable.toWeb(stream) as BodyInit`, and the undici `{ duplex: "half" }` extension to `RequestInit`.

## Verification

```
pnpm lint         # Found 0 warnings and 0 errors.
pnpm typecheck    # clean (cli + dashboard via tsgo)
pnpm format       # all matched files use the correct format
pnpm test         # 9 files / 80 tests (cli), 6 files / 53 tests (dashboard) — all passing
```
