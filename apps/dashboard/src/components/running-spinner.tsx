interface RunningSpinnerProps {
  size?: number;
  className?: string;
  /** Aria-only label; visually hidden. */
  label?: string;
}

/**
 * Rotating quarter-arc spinner used as the "running" status indicator on
 * the runs list. Replaces the pulsing blue dot per the design bundle (user
 * called this out explicitly in chat1.md: "the icon can just be a rotating
 * loader rather than a blue dot"). Color follows --running via currentColor.
 */
export function RunningSpinner({
  size = 14,
  className,
  label = "Running",
}: RunningSpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={["inline-flex shrink-0 text-[color:var(--running)]", className]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        className="animate-spin"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />
        <path
          d="M14 8a6 6 0 0 0-6-6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
