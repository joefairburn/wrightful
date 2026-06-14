/**
 * The single source of truth for the dashboard's density contract — the exact
 * sibling of `@/lib/theme`, for the compact/comfortable row-density toggle.
 *
 * Like the theme, the no-FOUC guarantee depends on two places agreeing at
 * different times: the inline boot script in `@/lib/theme-init-script` (runs
 * synchronously in `<head>` before first paint) and the `DensityToggle`
 * component (runs at click time after hydration). Both derive from the
 * constants here; the boot script can't `import` at runtime (it's a stringified
 * inline script), so it interpolates these same constants into its source at
 * build time — see `theme-init-script`.
 *
 * The `.density-compact` class on `<html>` overrides the `--row-h` / `--pad-x`
 * / `--gap` density tokens defined in `src/styles.css`.
 */
export const DENSITY_STORAGE_KEY = "density";
export const DENSITY_COMPACT_CLASS = "density-compact";
/** Wrightful defaults to comfortable density (no compact class). */
export const DEFAULT_COMPACT = false;

/** The stored value written for each density. */
export const DENSITY_VALUE_COMPACT = "compact";
export const DENSITY_VALUE_COMFORTABLE = "comfortable";

/**
 * The compact-off-by-default rule, as a pure function of the raw localStorage
 * value. This is the exact decision the FOUC-killer script encodes; keeping it
 * here (and unit-testing it) means the boot script and the toggle can't
 * disagree about what "no saved preference" means.
 */
export function prefersCompact(rawStored: string | null): boolean {
  return rawStored ? rawStored === DENSITY_VALUE_COMPACT : DEFAULT_COMPACT;
}

/** The string persisted to localStorage for a given density. */
export function densityValue(isCompact: boolean): string {
  return isCompact ? DENSITY_VALUE_COMPACT : DENSITY_VALUE_COMFORTABLE;
}

// --- client-only DOM helpers (safe to define on the server; never called there) ---

/** Whether `.density-compact` is currently applied to `<html>`. The toggle's source of truth. */
export function isCompactApplied(): boolean {
  return document.documentElement.classList.contains(DENSITY_COMPACT_CLASS);
}

/** Toggle the `.density-compact` class on `<html>`. */
export function applyDensity(isCompact: boolean): void {
  document.documentElement.classList.toggle(DENSITY_COMPACT_CLASS, isCompact);
}

/** Persist the chosen density; swallows localStorage failures (private mode etc). */
export function persistDensity(isCompact: boolean): void {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, densityValue(isCompact));
  } catch {
    // localStorage unavailable — the class is still toggled by applyDensity.
  }
}
