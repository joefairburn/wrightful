export interface DurationPoint {
  durationMs: number;
  label?: string;
}

export interface DurationChartProps {
  points: DurationPoint[];
  chronological?: boolean;
  width?: number;
  height?: number;
}

/**
 * Hand-rolled SVG line chart for per-test duration. RSC-safe (no client JS).
 * Shows the series as a polyline plus a faint rolling-average reference.
 *
 * We intentionally don't import a chart library here — every mainstream
 * option (recharts, visx, chart.js) is client-only. The shape of data we
 * care about right now is trivially drawable and we'd rather avoid the
 * hydration cost and dependency weight until a real need appears.
 */
export function DurationChart({
  points,
  chronological = true,
  width = 320,
  height = 80,
}: DurationChartProps) {
  if (points.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="No duration data"
      />
    );
  }

  const ordered = chronological ? points : [...points].reverse();
  const values = ordered.map((p) => p.durationMs);
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const padY = 4;
  const innerHeight = height - padY * 2;
  const step = ordered.length > 1 ? width / (ordered.length - 1) : 0;

  const y = (v: number): number => {
    if (max === min) return padY + innerHeight / 2;
    return padY + innerHeight - ((v - min) / (max - min)) * innerHeight;
  };

  const avg = values.reduce((s, n) => s + n, 0) / values.length;

  const d = ordered
    .map((p, i) => {
      const px = i * step;
      const py = y(p.durationMs);
      return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block" }}
      role="img"
      aria-label={`Duration trend over ${ordered.length} runs`}
    >
      {/* Average reference */}
      <line
        x1={0}
        x2={width}
        y1={y(avg)}
        y2={y(avg)}
        stroke="#d1d5db"
        strokeDasharray="3 3"
      />
      <path d={d} fill="none" stroke="#2563eb" strokeWidth={1.5} />
      {ordered.map((p, i) => {
        const cx = i * step;
        const cy = y(p.durationMs);
        return (
          <circle key={i} cx={cx} cy={cy} r={1.75} fill="#2563eb">
            {p.label && <title>{p.label}</title>}
          </circle>
        );
      })}
    </svg>
  );
}
