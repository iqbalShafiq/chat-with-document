import { describe, expect, it, vi } from "vitest";
import { normalizeToolResultOutput } from "@anvia/core/tool";
import type { TabularSheet } from "./types.js";
import { createChartTools } from "./chart-tools.js";
import type { DatasetResolver } from "./tools.js";

const SHEET: TabularSheet = {
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
    { name: "units", type: "number" },
  ],
  rows: [
    ["east", 100, 10],
    ["east", 200, 20],
    ["west", 50, 5],
    ["west", 150, 15],
    ["north", 80, 8],
  ],
};

function makeResolver(): DatasetResolver {
  return {
    listUploads: async () => [],
    resolveSheet: async () => SHEET,
    listDocumentTables: async () => [],
  };
}

function strictJson(output: unknown) {
  const normalized = normalizeToolResultOutput(output);
  expect(normalized.type).toBe("json");
  if (normalized.type !== "json") throw new Error("Expected JSON tool output");
  return normalized.value as Record<string, unknown>;
}

describe("create_chart", () => {
  it("builds a multi-series bar chart with a table", async () => {
    const [tool] = createChartTools({ resolver: makeResolver() });
    const out = strictJson(await tool!.call({
      source: { type: "upload", documentId: "d1" },
      chart: {
        kind: "bar",
        x: "region",
        series: [
          { column: "revenue", fn: "sum" },
          { column: "units", fn: "sum" },
        ],
        title: "Sales by region",
      },
    }));
    const chart = out.chart as { kind: string; labels: string[]; series: { name: string; values: number[] }[]; title: string };
    expect(chart.kind).toBe("bar");
    expect(chart.series).toHaveLength(2);
    expect(chart.title).toBe("Sales by region");
    expect(out).toHaveProperty("result");
  });

  it("builds a pie chart with an Other bucket", async () => {
    const [tool] = createChartTools({ resolver: makeResolver() });
    const out = strictJson(await tool!.call({
      source: { type: "upload", documentId: "d1" },
      chart: { kind: "pie", x: "region", column: "revenue", limit: 2 },
    }));
    const chart = out.chart as { kind: string; labels: string[]; values: number[] };
    expect(chart.kind).toBe("pie");
    expect(chart.labels).toContain("Other");
    expect(chart.labels).toHaveLength(3);
  });

  it("rejects unknown columns with the available list", async () => {
    const [tool] = createChartTools({ resolver: makeResolver() });
    await expect(tool!.call({
      source: { type: "upload", documentId: "d1" },
      chart: { kind: "bar", x: "harga", series: [{ column: "revenue", fn: "sum" }] },
    })).rejects.toThrow("Available columns");
    expect(vi.fn()).toHaveBeenCalledTimes(0);
  });
});
