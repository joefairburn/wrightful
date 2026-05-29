export interface MetricSparklineProps {
  /** Oldest on the left, newest on the right. */
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  areaOpacity?: number;
}

/**
 * Numeric line sparkline with area fill. Mirrors the design bundle's
 * `Sparkline` from `wrightful/project/primitives.jsx:265-285`. Used inside
 * KPI cards to show the per-bucket trend of a single metric next to the
 * headline value. (The categorical status-bar `Sparkline` in
 * `src/components/sparkline.tsx` is a different visualization despite the
 * shared name.)
 */
export function MetricSparkline({
  values,
  width = 80,
  height = 22,
  color = "var(--running)",
  areaOpacity = 0.12,
}: MetricSparklineProps) {
  if (values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 1.5;
  const w = width;
  const h = height;
  const stepX = (w - pad * 2) / Math.max(1, values.length - 1);
  const range = Math.max(1e-9, max - min);
  const points = values.map<[number, number]>((v, i) => [
    pad + i * stepX,
    h - pad - ((v - min) / range) * (h - pad * 2),
  ]);
  const line = points
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(" ");
  const lastX = points.at(-1)?.[0] ?? pad;
  const firstX = points[0]?.[0] ?? pad;
  const area = `${line} L${lastX},${h} L${firstX},${h} Z`;

  return (
    <svg aria-hidden="true" height={h} style={{ display: "block" }} width={w}>
      <path d={area} fill={color} opacity={areaOpacity} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}
