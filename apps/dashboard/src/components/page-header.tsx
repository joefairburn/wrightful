import type React from "react";

interface PageHeaderProps {
  title: string;
  /**
   * Composable subtitle — pass a fragment with the mono project slug + a
   * description. The design bundle's canonical shape is:
   *   <><span className="font-mono">{project.slug}</span> · 42 runs in the last 24h</>
   */
  subtitle?: React.ReactNode;
  /** Right-aligned slot for page actions (buttons, segmented controls). */
  right?: React.ReactNode;
}

/**
 * Shared page header used by the Runs / Flaky tests / Tests catalog / Insights
 * screens. Mirrors the `PageHeader` from the Wrightful design bundle
 * (wrightful/project/charts.jsx): 19px semibold title with -0.2 tracking, a
 * 12.5px muted subtitle below, optional right slot for buttons or segmented
 * controls.
 */
export function PageHeader({ title, subtitle, right }: PageHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border px-6 pt-[18px] pb-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-[-0.2px]">
            {title}
          </h1>
          {subtitle && (
            <div className="mt-[3px] text-[12.5px] text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="flex shrink-0 gap-2">{right}</div>}
      </div>
    </div>
  );
}
