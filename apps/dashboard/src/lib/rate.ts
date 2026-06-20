/**
 * The one owner of the `denominator <= 0 ? 0 : numerator / denominator * 100`
 * idiom that recurred (unowned) across the analytics loaders and pages.
 *
 * Returns a **percentage in the range 0..100** (the shape every existing call
 * site expected — pass rate, flake rate, growth, distribution share). A
 * non-positive denominator yields `0` rather than `NaN`/`Infinity`, so an empty
 * window renders a clean `0.0%` instead of garbage. PURE.
 */
export function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}
