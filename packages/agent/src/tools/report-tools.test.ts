import { describe, expect, it } from "vitest";
import { REPORT_TOOL_DEFINITIONS } from "./report-tools.js";

describe("REPORT_TOOL_DEFINITIONS", () => {
  it("exposes create_pdf_report, snapshot_chart, freeze_web_bundle", () => {
    expect(REPORT_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["create_pdf_report", "freeze_web_bundle", "snapshot_chart"].sort(),
    );
  });

  it("gives snapshot_chart a provider-safe object schema (no bare JSON)", async () => {
    const def = REPORT_TOOL_DEFINITIONS.find((d) => d.name === "snapshot_chart")!;
    const params = def.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    const props = params.properties as Record<string, { type?: string; oneOf?: unknown[] }>;
    expect(props.chart?.type ?? props.chart?.oneOf).toBeTruthy();
  });
});
