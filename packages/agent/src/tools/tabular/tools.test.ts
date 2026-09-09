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

function makeWriter() {
  const calls: unknown[] = [];
  return {
    calls,
    createDerived: async (input: never) => {
      calls.push(input);
      return { documentId: "d-saved", filename: "[derived] x.csv", origin: "created" as const, status: "queued" };
    },
    countDerived: async () => calls.length,
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

  it("analyze_dataset saveAs persists the result server-side", async () => {
    const writer = makeWriter();
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never, derived: { writer } });
    const tool = tools.find((t) => t.name === "analyze_dataset")!;
    const out = strictJson(await tool.call({
      source: { type: "upload", documentId: "d1" },
      operation: { op: "aggregate", groupBy: ["region"], metrics: [{ column: "revenue", fn: "sum" }] },
      saveAs: { name: "ringkas" },
    })) as Record<string, unknown>;
    expect(out).toMatchObject({ saved: { documentId: "d-saved", origin: "created" } });
    expect(writer.calls).toHaveLength(1);
  });

  it("query_dataset_sql saveAs types columns from the source sheet", async () => {
    const writer = makeWriter();
    const sqlRunner = vi.fn(async () => ({
      columns: ["region", "total"],
      rows: [["east", 100]],
      rowCount: 1,
      truncated: false,
    }));
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner, derived: { writer } });
    const tool = tools.find((t) => t.name === "query_dataset_sql")!;
    const out = strictJson(await tool.call({
      source: { type: "upload", documentId: "d1" },
      query: "SELECT region, SUM(revenue) AS total FROM t GROUP BY region",
      saveAs: { name: "total-region" },
    })) as Record<string, unknown>;
    expect(out).toMatchObject({ saved: { documentId: "d-saved" } });
    const input = writer.calls[0] as { parentDocumentId: string };
    expect(input.parentDocumentId).toBe("d1");
  });

  it("saveAs without a writer fails with guidance", async () => {
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const tool = tools.find((t) => t.name === "analyze_dataset")!;
    await expect(tool.call({
      source: { type: "upload", documentId: "d1" },
      operation: { op: "sort", column: "revenue", order: "desc" },
      saveAs: { name: "sorted" },
    })).rejects.toThrow("Saving results is not available");
  });

  it("unknown columns name the available columns", async () => {
    const tools = createTabularAnalysisTools({ resolver: makeResolver(), sqlRunner: vi.fn() as never });
    const tool = tools.find((t) => t.name === "analyze_dataset")!;
    await expect(tool.call({
      source: { type: "upload", documentId: "d1" },
      operation: { op: "stats", column: "harga" },
    })).rejects.toThrow('Available columns: "region", "revenue"');
  });

  it("read_dataset waits briefly for a queued document, then reads it", async () => {
    let calls = 0;
    const resolver: DatasetResolver = {
      ...makeResolver(),
      resolveSheet: async () => {
        calls += 1;
        if (calls < 3) throw new Error('Dataset "x.csv" is not ready yet (status: queued). Wait for ingest to finish, then call read_dataset again.');
        return SHEET;
      },
      getDatasetReadiness: async () => (calls < 3
        ? { ready: false as const, status: "queued", filename: "x.csv" }
        : { ready: true as const }),
    };
    const [tool] = createTabularAnalysisTools({ resolver, sqlRunner: vi.fn() as never, wait: { attempts: 5, intervalMs: 1 } });
    const out = await tool!.call({ source: { type: "upload", documentId: "d1" } });
    expect(strictJson(out)).toMatchObject({ name: "sales" });
    expect(calls).toBe(3);
  });

  it("read_dataset reports still-pending instead of duplicating work", async () => {
    const resolver: DatasetResolver = {
      ...makeResolver(),
      resolveSheet: async () => {
        throw new Error('Dataset "x.csv" is not ready yet (status: embedding_processing). Wait for ingest to finish, then call read_dataset again.');
      },
      getDatasetReadiness: async () => ({ ready: false as const, status: "embedding_processing", filename: "x.csv" }),
    };
    const [tool] = createTabularAnalysisTools({ resolver, sqlRunner: vi.fn() as never, wait: { attempts: 3, intervalMs: 1 } });
    await expect(tool!.call({ source: { type: "upload", documentId: "d1" } })).rejects.toThrow(
      "Do NOT create it again — call read_dataset once more later with the same documentId",
    );
  });
});
