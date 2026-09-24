import { describe, expect, it } from "vitest";
import { REPORT_TOOL_DEFINITIONS } from "./report-tools.js";

describe("REPORT_TOOL_DEFINITIONS", () => {
  it("exposes create_pdf_report, snapshot_chart, freeze_web_bundle", () => {
    expect(REPORT_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["create_pdf_report", "freeze_web_bundle", "snapshot_chart"].sort(),
    );
  });
});
