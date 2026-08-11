import { describe, expect, it } from "vitest";
import type { ToolApprovalRequest } from "@anvia/core";
import { buildEvalTools } from "./behavior-target.js";
import type { SessionConfig } from "./types.js";

function fakeApprovalRequest(toolName: string): ToolApprovalRequest {
  return {
    toolName,
    args: {},
    rawArgs: "{}",
    internalCallId: "call-1",
    run: { agentId: "eval-agent", runId: "run-1", sessionId: "eval-session" },
  };
}

describe("buildEvalTools", () => {
  it("registers document search tools when hasDocuments is true", () => {
    const { tools } = buildEvalTools({
      webSearchEnabled: true,
      imageGenEnabled: true,
      hasDocuments: true,
    });
    expect(tools.map((tool) => tool.name)).toContain("search_document_pages");
  });

  it("auto-rejects approval-gated tools when approvalMode is auto-reject", async () => {
    const { approvals } = buildEvalTools({
      webSearchEnabled: false,
      imageGenEnabled: true,
      hasDocuments: false,
      approvalMode: "auto-reject",
    });
    expect(approvals).toBeDefined();
    const decision = await approvals!.handler(fakeApprovalRequest("web_search"));
    expect(decision).toEqual({ approved: false });
  });

  it("auto-approves approval-gated tools when approvalMode is unset", async () => {
    const { approvals } = buildEvalTools({
      webSearchEnabled: false,
      imageGenEnabled: true,
      hasDocuments: false,
    });
    expect(approvals).toBeDefined();
    const decision = await approvals!.handler(fakeApprovalRequest("web_search"));
    expect(decision).toEqual({ approved: true });
  });

  it("wires no approval handler when no approval gate is active", () => {
    const { approvals } = buildEvalTools({
      webSearchEnabled: true,
      imageGenEnabled: true,
      hasDocuments: false,
    });
    expect(approvals).toBeUndefined();
  });

  it("registers view_image and its instruction when visionModelAvailable is true", () => {
    const { tools, instructions } = buildEvalTools({
      webSearchEnabled: true,
      imageGenEnabled: true,
      hasDocuments: false,
      visionModelAvailable: true,
    });
    expect(tools.map((tool) => tool.name)).toContain("view_image");
    expect(instructions.join("\n")).toContain("view_image");
  });
});
