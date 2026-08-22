import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataChart } from "./data-chart";

describe("DataChart", () => {
  it("renders an SVG with an accessible label for a bar chart", () => {
    const html = renderToStaticMarkup(
      <DataChart spec={{ kind: "bar", labels: ["east", "west"], series: [{ name: "revenue", values: [100, 200] }] }} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("aria-label");
    expect(html).toContain("revenue");
  });
});