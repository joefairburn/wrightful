# 2026-05-30 — Single theme contract (key / class / dark-default)

## What changed

Extracted the dashboard's theme contract into one module so the FOUC-killer boot
script and the runtime `ThemeToggle` can no longer disagree. Closes finding F79
(theme contract encoded independently in two places) from the 2026-05-30
architecture deepening review — the one finding the bulk implementation run's
planner dropped from its clusters.

## Details

New `apps/dashboard/src/lib/theme.ts` owns the three facts the no-FOUC guarantee
depends on: `THEME_STORAGE_KEY` (`"theme"`), `DARK_CLASS` (`"dark"`), and
`DEFAULT_DARK` (`true`), plus the pure `prefersDark(rawStored)` decision and the
client DOM helpers `isDarkApplied()` / `applyTheme(isDark)` / `persistTheme(isDark)`.

- `src/lib/theme-init-script.ts` now interpolates these constants into its inline
  script source (it can't `import` at runtime, so the values are baked in at build
  time via `JSON.stringify`). The emitted script is byte-for-byte identical to the
  previous hand-written literal.
- `src/components/theme-toggle.tsx` imports `isDarkApplied` / `applyTheme` /
  `persistTheme` instead of re-encoding the key and `.dark` class inline. The
  transition-suppression logic stays in the component (it's UI-specific).

Before, changing the storage key or default in one place and not the other would
silently break theme persistence with no type or test error.

## Tests

`apps/dashboard/src/__tests__/theme.test.ts` (7 tests): the dark-by-default rule
(`prefersDark`), the persisted-value mapping, and a parity guard asserting the
generated `themeInitScript` is derived from the contract constants.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 603 passed.
- `pnpm check` — 0 errors, 88 warnings.
