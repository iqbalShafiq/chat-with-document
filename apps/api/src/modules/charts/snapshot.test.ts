import { describe, expect, it } from "vitest";
import { assertValidChartSpec, chartSpecToSvg } from "./snapshot.js";

describe("chartSpecToSvg", () => {
  it("renders a bar chart spec to SVG", () => {
    const svg = chartSpecToSvg({
      kind: "bar",
      labels: ["A", "B"],
      series: [{ name: "sum(x)", values: [3, 7] }],
      title: "T",
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("A");
  });

  it("escapes titles so captions cannot break markup", () => {
    const svg = chartSpecToSvg({
      kind: "pie",
      labels: ["<b>X</b>"],
      values: [5],
      title: "<script>",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("rejects request-shaped and non-finite specs loudly", () => {
    expect(() =>
      assertValidChartSpec({ kind: "bar", x: "region", series: [{ column: "revenue", fn: "sum" }] }),
    ).toThrow("Invalid chart spec");
    expect(() =>
      assertValidChartSpec({ kind: "pie", labels: ["a"], values: [Number.NaN] }),
    ).toThrow("Invalid chart spec");
    expect(() => assertValidChartSpec(null)).toThrow("Invalid chart spec");
  });

  it("renders histogram bins with {min,max,count} and rejects the legacy number[] shape", () => {
    const svg = chartSpecToSvg({
      kind: "histogram",
      bins: [
        { min: 0, max: 10, count: 3 },
        { min: 10, max: 20, count: 7 },
      ],
      title: "Distribusi",
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("10");
    expect(svg).toContain("20");
    expect(() =>
      assertValidChartSpec({ kind: "histogram", bins: [1, 2, 3] }),
    ).toThrow("Invalid chart spec");
  });
});
