import { describe, expect, it, vi } from "vitest";
import { normalizeToolResultOutput } from "@anvia/core/tool";
import { createDerivedDatasetTools, type DerivedDocumentWriter } from "./derived-tools.js";

function strictJson(output: unknown) {
  const normalized = normalizeToolResultOutput(output);
  expect(normalized.type).toBe("json");
  if (normalized.type !== "json") throw new Error("Expected JSON tool output");
  return normalized.value as Record<string, unknown>;
}

function makeWriter(): DerivedDocumentWriter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    createDerived: async (input: never) => {
      calls.push(input);
      return { documentId: "d-new", filename: "[derived] a.csv", origin: "created" as const, status: "queued" };
    },
    countDerived: async () => calls.length,
  };
}

describe("create_dataset", () => {
  it("creates a CSV document and returns a preview", async () => {
    const writer = makeWriter();
    const [tool] = createDerivedDatasetTools({ writer });
    const out = strictJson(await tool!.call({
      name: "ringkas",
      columns: ["region", "revenue"],
      rows: [["east", 100], ["west", 200]],
      derivedFrom: { documentId: "d-parent" },
    }));
    expect(out).toMatchObject({ documentId: "d-new", origin: "created", rowCount: 2 });
    expect(writer.calls).toHaveLength(1);
  });

  it("rejects duplicate columns and ragged rows", async () => {
    const writer = makeWriter();
    const [tool] = createDerivedDatasetTools({ writer });
    await expect(tool!.call({ name: "a", columns: ["x", "X"], rows: [["1", "2"]] })).rejects.toThrow("Duplicate column");
    await expect(tool!.call({ name: "a", columns: ["x"], rows: [["1", "2"]] })).rejects.toThrow("has 2 cells but 1 columns");
    expect(writer.calls).toHaveLength(0);
  });
});

describe("fetch_dataset_from_url", () => {
  it("downloads and stores a CSV", async () => {
    const writer = makeWriter();
    const tools = createDerivedDatasetTools({
      writer,
      fetchFn: (async () => new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv" } })) as typeof fetch,
    });
    const tool = tools.find((t) => t.name === "fetch_dataset_from_url")!;
    const out = strictJson(await tool.call({ url: "https://example.com/data.csv", reason: "need data for chart" }));
    expect(out).toMatchObject({ origin: "fetched", originUrl: "https://example.com/data.csv" });
    expect(writer.calls).toHaveLength(1);
  });

  it("rejects non-tabular content with guidance", async () => {
    const writer = makeWriter();
    const tools = createDerivedDatasetTools({
      writer,
      fetchFn: (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch,
    });
    const tool = tools.find((t) => t.name === "fetch_dataset_from_url")!;
    await expect(tool.call({ url: "https://example.com/page", reason: "test" })).rejects.toThrow("web_fetch");
    expect(writer.calls).toHaveLength(0);
  });

  it("requires approval with the caller reason when the gate is closed", async () => {
    const writer = makeWriter();
    const tools = createDerivedDatasetTools({ writer, fetchFn: vi.fn() as never });
    const tool = tools.find((t) => t.name === "fetch_dataset_from_url")!;
    const requiresApproval = tool.requiresApproval as (args: { reason: string }, context: unknown) => Promise<false | { reason: string }>;
    await expect(requiresApproval({ reason: "need data" }, {})).resolves.toEqual({ reason: "need data" });
  });

  it("bypasses approval when the web gate is enabled", async () => {
    const writer = makeWriter();
    const tools = createDerivedDatasetTools({ writer, fetchFn: vi.fn() as never, webFetchGate: { enabled: true } });
    const tool = tools.find((t) => t.name === "fetch_dataset_from_url")!;
    const requiresApproval = tool.requiresApproval as (args: { reason: string }, context: unknown) => Promise<false | { reason: string }>;
    await expect(requiresApproval({ reason: "need data" }, {})).resolves.toBe(false);
  });
});
