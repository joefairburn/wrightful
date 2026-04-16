import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sparkline } from "../app/components/sparkline";
import { DurationChart } from "../app/components/duration-chart";

describe("Sparkline", () => {
  it("renders one coloured rect per point", () => {
    const html = renderToStaticMarkup(
      <Sparkline
        points={[
          { status: "passed" },
          { status: "failed" },
          { status: "flaky" },
        ]}
        width={30}
        height={10}
        gap={0}
      />,
    );
    // One <rect> per point
    const rects = html.match(/<rect/g) ?? [];
    expect(rects).toHaveLength(3);
    // Status colours appear in the output
    expect(html).toContain("#16a34a"); // passed
    expect(html).toContain("#dc2626"); // failed
    expect(html).toContain("#ea580c"); // flaky
  });

  it("attaches labels as <title> tooltips", () => {
    const html = renderToStaticMarkup(
      <Sparkline
        points={[{ status: "passed", label: "run #1 — 2.3s" }]}
        width={10}
        height={10}
      />,
    );
    expect(html).toContain("<title>run #1 — 2.3s</title>");
  });

  it("renders an empty svg when given no points", () => {
    const html = renderToStaticMarkup(
      <Sparkline points={[]} width={20} height={10} />,
    );
    expect(html).toContain('aria-label="No runs"');
    expect(html).not.toContain("<rect");
  });
});

describe("DurationChart", () => {
  it("renders a polyline path with one point per data entry", () => {
    const html = renderToStaticMarkup(
      <DurationChart
        points={[{ durationMs: 100 }, { durationMs: 200 }, { durationMs: 150 }]}
        width={100}
        height={40}
      />,
    );
    expect(html).toContain("<path");
    // 3 <circle> markers + M/L path commands
    const circles = html.match(/<circle/g) ?? [];
    expect(circles).toHaveLength(3);
    expect(html).toMatch(/d="M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+"/);
  });

  it("emits a dashed average reference line", () => {
    const html = renderToStaticMarkup(
      <DurationChart
        points={[{ durationMs: 100 }, { durationMs: 200 }]}
        width={100}
        height={40}
      />,
    );
    expect(html).toContain("stroke-dasharray");
  });

  it("renders an empty svg for empty input", () => {
    const html = renderToStaticMarkup(
      <DurationChart points={[]} width={50} height={20} />,
    );
    expect(html).toContain('aria-label="No duration data"');
    expect(html).not.toContain("<path");
  });
});
