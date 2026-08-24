import { describe, expect, it } from "vitest";
import type { AgentInteractionRequest } from "@anvia/core/agent/interactions";
import { buildEvalTools } from "./behavior-target.js";
import type { SessionConfig } from "./types.js";

function fakeApprovalRequest(toolName: string): AgentInteractionRequest {
  return {
    type: "tool-approval",
    id: "interaction-1",
    toolName,
    toolCallId: "call-1",
    internalCallId: "internal-call-1",
    input: {},
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

  it("auto-rejects native approval interactions when approvalMode is auto-reject", async () => {
    const { interactionResponder } = buildEvalTools({
      webSearchEnabled: false,
      imageGenEnabled: true,
      hasDocuments: false,
      approvalMode: "auto-reject",
    });
    expect(interactionResponder).toBeDefined();
    const decision = await interactionResponder!(fakeApprovalRequest("web_search"));
    expect(decision).toEqual({
      type: "tool-approval",
      approved: false,
      reason: "Eval approval policy rejected the request.",
    });
  });

  it("auto-approves native approval interactions when approvalMode is unset", async () => {
    const { interactionResponder } = buildEvalTools({
      webSearchEnabled: false,
      imageGenEnabled: true,
      hasDocuments: false,
    });
    expect(interactionResponder).toBeDefined();
    const decision = await interactionResponder!(fakeApprovalRequest("web_search"));
    expect(decision).toEqual({ type: "tool-approval", approved: true });
  });

  it("keeps an interaction responder for native clarification even without approval gates", async () => {
    const { interactionResponder } = buildEvalTools({
      webSearchEnabled: true,
      imageGenEnabled: true,
      hasDocuments: false,
    });
    expect(interactionResponder).toBeDefined();
    const decision = await interactionResponder!({
      type: "tool-question",
      id: "interaction-2",
      toolName: "request_clarification",
      toolCallId: "call-2",
      internalCallId: "internal-call-2",
      questions: [{ id: "style", text: "Which style?" }],
    });
    expect(decision).toEqual({
      type: "tool-question",
      answers: [{ questionId: "style", value: "watercolor" }],
    });
  });

  it("registers view_image and its instruction when visionModelAvailable is false", () => {
    const { tools, instructions } = buildEvalTools({
      webSearchEnabled: true,
      imageGenEnabled: true,
      hasDocuments: false,
      visionModelAvailable: false,
    });
    expect(tools.map((tool) => tool.name)).toContain("view_image");
    expect(instructions.join("\n")).toContain("view_image");
  });

  it("registers view_image for vision model when web search is available (universal wiring)", () => {
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
