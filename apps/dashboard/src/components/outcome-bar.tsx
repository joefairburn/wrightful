interface OutcomeBarProps {
  passed?: number;
  failed?: number;
  flaky?: number;
  skipped?: number;
  /** Bar height in px. Reference uses 6 for tables and 7-8 for hero contexts. */
  height?: number;
  /** Override the denominator when the bar reflects a fraction of a larger total. */
  total?: number;
  /** Min width in px. Default 80, matches the design bundle. */
  minWidth?: number;
}

/**
 * Stacked horizontal outcome bar (pass / flaky / fail / skipped). Ports
 * `OutcomeBar` from `wrightful/project/primitives.jsx:115-130`. Background
 * is `--bg-3` (the "raised tint" surface) — segments overlay it
 * proportionally; empty buckets render no segment.
 */
export function OutcomeBar({
  passed = 0,
  failed = 0,
  flaky = 0,
  skipped = 0,
  height = 6,
  total,
  minWidth = 80,
}: OutcomeBarProps) {
  const sum = total ?? passed + failed + flaky + skipped;
  const denom = sum === 0 ? 1 : sum;
  const segments = [
    { key: "passed", n: passed, color: "var(--pass)" },
    { key: "flaky", n: flaky, color: "var(--flaky)" },
    { key: "failed", n: failed, color: "var(--fail)" },
    { key: "skipped", n: skipped, color: "var(--skipped)" },
  ];
  return (
    <div
      className="flex overflow-hidden rounded-full bg-bg-3"
      role="img"
      aria-label={`${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped`}
      style={{ height, minWidth }}
      title={`${passed} passed · ${failed} failed · ${flaky} flaky · ${skipped} skipped`}
    >
      {segments.map((s) =>
        s.n > 0 ? (
          <div
            key={s.key}
            style={{
              width: `${(s.n / denom) * 100}%`,
              background: s.color,
            }}
          />
        ) : null,
      )}
    </div>
  );
}
