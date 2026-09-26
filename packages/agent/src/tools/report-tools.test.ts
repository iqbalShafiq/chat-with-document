import { describe, expect, it } from "vitest";
import { REPORT_TOOL_DEFINITIONS, createReportTools } from "./report-tools.js";

describe("REPORT_TOOL_DEFINITIONS", () => {
  it("exposes create, edit, snapshot, and freeze tools", () => {
    expect(REPORT_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["create_pdf_report", "edit_pdf_report", "freeze_web_bundle", "snapshot_chart"].sort(),
    );
  });

  it("edits revise the same document instead of duplicating", async () => {
    const tools = createReportTools({
      createReport: async () => ({ documentId: "d1", filename: "r.pdf" }),
      editReport: async (input) => ({ documentId: input.documentId, filename: "r.pdf" }),
      snapshotChart: async () => ({ imageId: "img-1" }),
      freezeBundle: async () => ({ id: "b1" }),
    });
    const edit = tools.find((t) => t.name === "edit_pdf_report")!;
    const out = (await edit.call({ documentId: "d1", title: "v2" })) as unknown as {
      documentId: string;
    };
    expect(out.documentId).toBe("d1");
  });

  it("gives snapshot_chart a provider-safe object schema (no bare JSON)", async () => {
    const def = REPORT_TOOL_DEFINITIONS.find((d) => d.name === "snapshot_chart")!;
    const params = def.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    const props = params.properties as Record<string, { type?: string; oneOf?: unknown[] }>;
    expect(props.chart?.type ?? props.chart?.oneOf).toBeTruthy();
  });

  it("accepts the histogram shape the chart tools emit ({min,max,count} bins)", async () => {
    const seen: unknown[] = [];
    const tools = createReportTools({
      createReport: async () => ({ documentId: "d1", filename: "r.pdf" }),
      editReport: async (input) => ({ documentId: input.documentId, filename: "r.pdf" }),
      snapshotChart: async (input) => {
        seen.push(input.chart);
        return { imageId: "img-1" };
      },
      freezeBundle: async () => ({ id: "b1" }),
    });
    const snapshot = tools.find((t) => t.name === "snapshot_chart")!;
    await snapshot.call({
      caption: "Distribusi revenue",
      chart: {
        kind: "histogram",
        bins: [
          { min: 0, max: 10, count: 3 },
          { min: 10, max: 20, count: 7 },
        ],
      },
    });
    expect(seen).toHaveLength(1);
    await expect(
      snapshot.call({ caption: "legacy", chart: { kind: "histogram", bins: [1, 2, 3] } }),
    ).rejects.toThrow();
  });
});
