import { describe, expect, it, vi } from "vitest";
import type { TabularSheet } from "./types.js";
import { createTabularAnalysisTools, type DatasetResolver } from "./tools.js";

const SHEET: TabularSheet = {
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["east", 100],
    ["west", 200],
  ],
};

function makeResolver(): DatasetResolver {
  return {
    listUploads: async () => [
      { documentId: "d1", filename: "sales.csv", sheets: [{ name: "sales", columns: SHEET.columns, rowCount: 2 }] },
    ],
    resolveSheet: async (ref) => {
      expect(ref).toEqual({ type: "upload", documentId: "d1" });
      return SHEET;
    },
    listDocumentTables: async () => [],
  };
}

describe("tabular tools", () => {
  it("read_dataset returns schema + preview", async () => {
    const [tool] = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const out = await tool!.call({ source: { type: "upload", documentId: "d1" } });
    const text = Array.isArray(out) ? out.find((p) => p.type === "text")?.text : out;
    expect(typeof text === "string" ? JSON.parse(text) : text).toMatchObject({
      name: "sales",
      rowCount: 2,
      columns: [
        { name: "region", type: "string" },
        { name: "revenue", type: "number" },
      ],
    });
  });

  it("analyze_dataset returns a chart in output", async () => {
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const tool = tools.find((t) => t.name === "analyze_dataset")!;
    const out = await tool.call({
      source: { type: "upload", documentId: "d1" },
      operation: { op: "aggregate", groupBy: ["region"], metrics: [{ column: "revenue", fn: "sum" }] },
    });
    const text = Array.isArray(out) ? out.find((p) => p.type === "text")?.text : out;
    expect(typeof text === "string" ? JSON.parse(text) : text).toMatchObject({ operation: "aggregate", chart: { kind: "bar" } });
  });

  it("query_dataset_sql delegates to the sql runner", async () => {
    const sqlRunner = vi.fn(async () => ({
      columns: ["region", "total"],
      rows: [["east", 100]],
      rowCount: 1,
      truncated: false,
    }));
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner });
    const tool = tools.find((t) => t.name === "query_dataset_sql")!;
    const out = await tool.call({ source: { type: "upload", documentId: "d1" }, query: "SELECT * FROM sales" });
    expect(sqlRunner).toHaveBeenCalled();
    const text = Array.isArray(out) ? out.find((p) => p.type === "text")?.text : out;
    expect(typeof text === "string" ? JSON.parse(text) : text).toMatchObject({ rowCount: 1 });
  });
});