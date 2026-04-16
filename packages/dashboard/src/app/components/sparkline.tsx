export type SparklineStatus =
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "timedout";

export interface SparklinePoint {
  status: SparklineStatus;
  /** Optional label shown via the native `<title>` tooltip on hover. */
  label?: string;
}

export interface SparklineProps {
  points: SparklinePoint[];
  /** Oldest on the left, newest on the right. Defaults to true. */
  chronological?: boolean;
  width?: number;
  height?: number;
  /** Gap between bars in px. */
  gap?: number;
}

const COLORS: Record<SparklineStatus, string> = {
  passed: "#16a34a",
  failed: "#dc2626",
  flaky: "#ea580c",
  skipped: "#9ca3af",
  timedout: "#dc2626",
};

/**
 * Minimal status sparkline — renders one bar per data point, coloured by
 * status. Pure SVG so it works inside Server Components (no client JS).
 *
 * Accepting a simple `points[]` keeps the callsites unsurprising. We keep the
 * sizing API restrictive on purpose: every place this lives is a small inline
 * visualization, so a handful of pixels' worth of flexibility is all we need.
 */
export function Sparkline({
  points,
  chronological = true,
  width = 160,
  height = 24,
  gap = 1,
}: SparklineProps) {
  if (points.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        style={{ display: "block" }}
        role="img"
        aria-label="No runs"
      />
    );
  }

  const ordered = chronological ? points : [...points].reverse();
  const barWidth = Math.max(
    1,
    (width - gap * (ordered.length - 1)) / ordered.length,
  );

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block" }}
      role="img"
      aria-label={`Last ${ordered.length} runs`}
    >
      {ordered.map((p, i) => {
        const x = i * (barWidth + gap);
        return (
          <rect
            key={i}
            x={x}
            y={0}
            width={barWidth}
            height={height}
            fill={COLORS[p.status]}
          >
            {p.label && <title>{p.label}</title>}
          </rect>
        );
      })}
    </svg>
  );
}
