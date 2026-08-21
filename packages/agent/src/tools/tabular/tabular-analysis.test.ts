import { describe, expect, it } from "vitest";
import type { TabularSheet } from "./types.js";
import { runAnalysis } from "./tabular-analysis.js";

const SHEET: TabularSheet = {
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["east", 100],
    ["east", 200],
    ["west", 50],
    ["west", 150],
  ],
};

describe("runAnalysis", () => {
  it("aggregates with groupBy and returns a bar chart", () => {
    const result = runAnalysis(SHEET, {
      op: "aggregate",
      groupBy: ["region"],
      metrics: [{ column: "revenue", fn: "mean" }],
    });
    expect(result.chart?.kind).toBe("bar");
    expect(result.result?.rows).toEqual([
      ["east", 150],
      ["west", 100],
    ]);
  });

  it("computes correlation with a scatter chart", () => {
    const sheet: TabularSheet = {
      name: "xy",
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [
        [1, 2],
        [2, 4],
        [3, 6],
      ],
    };
    const result = runAnalysis(sheet, { op: "correlation", x: "x", y: "y" });
    expect(result.chart?.kind).toBe("scatter");
    expect(result.result).toBeUndefined();
    expect(result.summary).toMatch(/1/);
  });

  it("filters rows", () => {
    const result = runAnalysis(SHEET, {
      op: "filter",
      column: "revenue",
      predicate: "gte",
      value: 100,
    });
    expect(result.result?.rows).toHaveLength(3);
  });

  it("profiles a numeric column with a histogram", () => {
    const result = runAnalysis(SHEET, { op: "profile", column: "revenue" });
    expect(result.chart?.kind).toBe("histogram");
    expect(result.summary).toMatch(/count/);
  });

  it("returns an explicit message when a column is all null", () => {
    const sheet: TabularSheet = {
      name: "bad",
      columns: [{ name: "x", type: "number" }],
      rows: [[null], [null]],
    };
    const result = runAnalysis(sheet, { op: "profile", column: "x" });
    expect(result.summary.toLowerCase()).toContain("no usable data");
  });
});
