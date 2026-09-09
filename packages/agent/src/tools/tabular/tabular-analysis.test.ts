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

  it("computes stats for one numeric column", () => {
    const result = runAnalysis(SHEET, { op: "stats", column: "revenue" });
    expect(result.operation).toBe("stats");
    expect(result.chart).toBeUndefined();
    expect(result.summary).toContain("count=4");
    expect(result.summary).toContain("mean=125");
    expect(result.summary).toContain("median=125");
  });

  it("fits a regression with R² and a scatter chart", () => {
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
    const result = runAnalysis(sheet, { op: "regression", x: "x", y: "y", predictFor: [4] });
    expect(result.operation).toBe("regression");
    expect(result.summary).toContain("R² = 1.0000");
    expect(result.chart?.kind).toBe("scatter");
  });

  it("pairs rows for correlation instead of misaligning columns", () => {
    const sheet: TabularSheet = {
      name: "paired",
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [
        [1, 2],
        [null, 4],
        [3, null],
        [4, 8],
      ],
    };
    const result = runAnalysis(sheet, { op: "correlation", x: "x", y: "y" });
    expect(result.chart?.kind).toBe("scatter");
    expect(result.summary).toMatch(/r = 1\.0000/);
  });

  it("aggregates multiple metrics with count_distinct and stddev", () => {
    const result = runAnalysis(SHEET, {
      op: "aggregate",
      groupBy: ["region"],
      metrics: [
        { column: "revenue", fn: "sum" },
        { column: "revenue", fn: "count_distinct" },
        { column: "revenue", fn: "stddev" },
      ],
    });
    expect(result.chart?.kind).toBe("bar");
    if (result.chart?.kind !== "bar") throw new Error("expected bar chart");
    expect(result.chart.series).toHaveLength(3);
    expect(result.chart.series[1]!.values).toEqual([2, 2]);
    expect(result.result?.rows[0]).toEqual(["east", 300, 2, expect.any(Number)]);
  });

  it("ranks groups for grouped top_n", () => {
    const result = runAnalysis(SHEET, {
      op: "top_n",
      column: "revenue",
      n: 1,
      groupBy: ["region"],
      metric: "sum",
    });
    expect(result.result?.rows).toEqual([["east", 300]]);
    expect(result.chart?.kind).toBe("bar");
  });

  it("builds trends over ISO date strings", () => {
    const sheet: TabularSheet = {
      name: "dates",
      columns: [
        { name: "month", type: "string" },
        { name: "sales", type: "number" },
      ],
      rows: [
        ["2026-03", 30],
        ["2026-01", 10],
        ["2026-02", 20],
      ],
    };
    const result = runAnalysis(sheet, { op: "trend", x: "month", y: "sales" });
    expect(result.chart?.kind).toBe("line");
    if (result.chart?.kind !== "line") throw new Error("expected line chart");
    expect(result.chart.labels).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("profiles a categorical column with counts and a bar chart", () => {
    const result = runAnalysis(SHEET, { op: "profile", column: "region" });
    expect(result.summary).toContain("2 unique values");
    expect(result.chart?.kind).toBe("bar");
    expect(result.result?.rows).toEqual([
      ["east", 2],
      ["west", 2],
    ]);
  });

  it("profiles all columns as an overview table", () => {
    const result = runAnalysis(SHEET, { op: "profile" });
    expect(result.result?.columns.map((c) => c.name)).toEqual(["column", "type", "nulls", "unique", "top value"]);
    expect(result.result?.rows).toHaveLength(2);
  });

  it("flags outliers with the IQR fence", () => {
    const sheet: TabularSheet = {
      name: "vals",
      columns: [{ name: "v", type: "number" }],
      rows: [[10], [11], [12], [11], [10], [200]],
    };
    const result = runAnalysis(sheet, { op: "outliers", column: "v" });
    expect(result.result?.rows).toEqual([[200]]);
    expect(result.summary).toContain("1 outlier");
  });

  it("builds a count crosstab", () => {
    const sheet: TabularSheet = {
      name: "ct",
      columns: [
        { name: "region", type: "string" },
        { name: "product", type: "string" },
      ],
      rows: [
        ["east", "a"],
        ["east", "a"],
        ["west", "b"],
      ],
    };
    const result = runAnalysis(sheet, { op: "crosstab", x: "region", y: "product" });
    expect(result.result?.columns.map((c) => c.name)).toEqual(["region \\ product", "a", "b"]);
    expect(result.result?.rows).toEqual([
      ["east", 2, 0],
      ["west", 0, 1],
    ]);
  });
});
