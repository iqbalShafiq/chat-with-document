import { describe, expect, it } from "vitest";
import { parseChartSpec, parseTableDto } from "./data-analysis";

describe("parseChartSpec", () => {
  it("accepts a valid bar chart", () => {
    const spec = parseChartSpec({ kind: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] });
    expect(spec?.kind).toBe("bar");
  });
  it("rejects malformed specs", () => {
    expect(parseChartSpec({ kind: "nope" })).toBeNull();
    expect(parseChartSpec(null)).toBeNull();
  });
});

describe("parseTableDto", () => {
  it("accepts a valid table", () => {
    const t = parseTableDto({ columns: [{ name: "region", type: "string" }], rows: [["east"]] });
    expect(t?.rows).toEqual([["east"]]);
  });
  it("rejects invalid tables", () => {
    expect(parseTableDto({ columns: "x" })).toBeNull();
  });
});