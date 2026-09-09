import { describe, expect, it } from "vitest";
import { chartEmbedIndex } from "#/lib/data-analysis";
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
});
