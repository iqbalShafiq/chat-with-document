import { describe, expect, it } from "vitest";
import { chartSpecToSvg } from "./snapshot.js";

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
});
