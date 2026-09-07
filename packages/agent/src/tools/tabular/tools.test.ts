import { describe, expect, it, vi } from "vitest";
import { normalizeToolResultOutput } from "@anvia/core/tool";
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

function strictJson(output: unknown) {
  const normalized = normalizeToolResultOutput(output);
  expect(normalized.type).toBe("json");
  if (normalized.type !== "json") {
    throw new Error(`Expected JSON tool output, received ${normalized.type}`);
  }
  return normalized.value;
}

describe("tabular tools", () => {
  it("read_dataset returns schema + preview", async () => {
    const [tool] = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const out = await tool!.call({ source: { type: "upload", documentId: "d1" } });
    expect(strictJson(out)).toMatchObject({
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
    expect(strictJson(out)).toMatchObject({ operation: "aggregate", chart: { kind: "bar" } });
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
    expect(strictJson(out)).toMatchObject({ rowCount: 1 });
  });

  it("rejects non-JSON SQL results through the output schema", async () => {
    const sqlRunner = vi.fn(async () => ({
      columns: ["region"],
      rows: [["east"]],
      rowCount: 1,
      truncated: undefined as never,
    }));
    const tools = createTabularAnalysisTools({
      resolver: makeResolver(),
      sqlRunner,
    });
    const tool = tools.find((candidate) => candidate.name === "query_dataset_sql")!;

    await expect(
      tool.call({
        source: { type: "upload", documentId: "d1" },
        query: "SELECT * FROM sales",
      }),
    ).rejects.toThrow();
  });
});
