import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataChart, buildChartOption, chartAriaLabel } from "./data-chart";

describe("DataChart", () => {
  it("renders a container with a concise accessible label for a bar chart", () => {
    const html = renderToStaticMarkup(
      <DataChart spec={{ kind: "bar", labels: ["east", "west"], series: [{ name: "revenue", values: [100, 200] }] }} />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
    expect(html).toContain("bar chart");
    expect(html).not.toContain("100, 200");
  });

  it("builds legend data for multi-series charts", () => {
    const option = buildChartOption({
      kind: "bar",
      labels: ["a"],
      series: [
        { name: "s1", values: [1] },
        { name: "s2", values: [2] },
      ],
    }) as { legend?: { itemGap?: number }; series?: Array<{ name?: string }> };
    expect(option.legend).toBeDefined();
    expect(option.legend?.itemGap).toBeGreaterThan(0);
    expect(option.series?.map((s) => s.name)).toEqual(["s1", "s2"]);
  });

  it("builds a pie option and a concise label", () => {
    const option = buildChartOption({ kind: "pie", labels: ["a", "b"], values: [1, 2] }) as {
      series?: Array<{ type?: string; data?: Array<{ name?: string; value?: number }> }>;
    };
    expect(option.series?.[0]?.type).toBe("pie");
    expect(chartAriaLabel({ kind: "pie", labels: ["a", "b"], values: [1, 2] })).toContain("2 slices");
  });
});