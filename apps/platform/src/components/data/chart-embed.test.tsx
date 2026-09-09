import { describe, expect, it } from "vitest";
import { chartEmbedIndex } from "#/lib/data-analysis";
import { collectThreadChartSpecs } from "./chart-registry-context";
import { chartAltToIndex } from "./chart-embed";

describe("chart embed references", () => {
  it("parses chart:N alt text to a 1-based index", () => {
    expect(chartEmbedIndex("chart:1")).toBe(1);
    expect(chartEmbedIndex("chart:12")).toBe(12);
    expect(chartEmbedIndex("chart:0")).toBeNull();
    expect(chartEmbedIndex("chart:x")).toBeNull();
    expect(chartEmbedIndex("a photo")).toBeNull();
    expect(chartEmbedIndex(null)).toBeNull();
  });

  it("exposes the same parser through the embed component helper", () => {
    expect(chartAltToIndex("chart:3")).toBe(3);
    expect(chartAltToIndex("other")).toBeNull();
  });

  it("collects chart specs across messages in thread order", () => {
    const bar = { kind: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] };
    const pie = { kind: "pie", labels: ["a"], values: [1] };
    const specs = collectThreadChartSpecs([
      { parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: pie }) }] },
      { parts: [{ type: "text", text: "hello" }] },
      { parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: bar }) }] },
      { parts: [{ type: "tool", state: "input-streaming", output: JSON.stringify({ chart: bar }) }] },
    ] as never);
    expect(specs).toEqual([pie, bar]);
  });
});
