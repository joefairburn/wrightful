import type React from "react";

type Status =
  | "passed"
  | "failed"
  | "timedout"
  | "flaky"
  | "interrupted"
  | "skipped"
  | "running";

interface StatusGlyphProps {
  status: string;
  size?: number;
}

const COLOR_BY_STATUS: Record<Status, string> = {
  passed: "var(--pass)",
  failed: "var(--fail)",
  timedout: "var(--fail)",
  flaky: "var(--flaky)",
  interrupted: "var(--flaky)",
  skipped: "var(--skipped)",
  running: "var(--running)",
};

/**
 * Status indicator with shape-per-status — colorblind safety per the
 * Wrightful design bundle. Ports `StatusGlyph` from
 * `wrightful/project/primitives.jsx:63-112`.
 *
 * - passed:  check mark stroke
 * - failed:  X stroke
 * - flaky:   zigzag stroke
 * - skipped: three centered dots
 * - running: rotating quarter-arc spinner
 */
export function StatusGlyph({
  status,
  size = 14,
}: StatusGlyphProps): React.ReactElement {
  const color = COLOR_BY_STATUS[status as Status] ?? "var(--muted-foreground)";
  const stroke = Math.max(1.4, size / 8);

  if (status === "running") {
    const r = (size - stroke) / 2 - 0.5;
    const cx = size / 2;
    const cy = size / 2;
    return (
      <span
        role="img"
        aria-label="running"
        className="inline-flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        <svg
          aria-hidden="true"
          className="animate-spin"
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          width={size}
        >
          <circle
            cx={cx}
            cy={cy}
            fill="none"
            opacity="0.25"
            r={r}
            stroke={color}
            strokeWidth={stroke}
          />
          <path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={stroke}
          />
        </svg>
      </span>
    );
  }

  let glyph: React.ReactNode = null;
  if (status === "passed") {
    glyph = (
      <path
        d="M3 8 L6.5 11.5 L13 4.5"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={stroke}
      />
    );
  } else if (status === "failed" || status === "timedout") {
    glyph = (
      <g stroke={color} strokeLinecap="round" strokeWidth={stroke}>
        <path d="M4 4 L12 12" />
        <path d="M12 4 L4 12" />
      </g>
    );
  } else if (status === "flaky" || status === "interrupted") {
    glyph = (
      <path
        d="M3 10.5 L6 6 L9 9.5 L13 4.5"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={stroke}
      />
    );
  } else if (status === "skipped") {
    glyph = (
      <g stroke={color} strokeLinecap="round" strokeWidth={stroke}>
        <circle cx="4.5" cy="8" fill={color} r="0.8" />
        <circle cx="8" cy="8" fill={color} r="0.8" />
        <circle cx="11.5" cy="8" fill={color} r="0.8" />
      </g>
    );
  } else {
    // Fallback: simple filled dot for unknown statuses.
    glyph = <circle cx="8" cy="8" fill={color} r="3" />;
  }

  return (
    <span
      role="img"
      aria-label={status}
      className="inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
        {glyph}
      </svg>
    </span>
  );
}
