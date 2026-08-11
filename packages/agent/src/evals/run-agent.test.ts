import { describe, expect, it } from "vitest";
import { createScriptedCompletionModel } from "./stub-scopes.js";
import { runAgentAndCollect } from "./run-agent.js";
import { AgentBuilder } from "@anvia/core";

describe("runAgentAndCollect", () => {
  it("collects tool calls, approvals, and output text", async () => {
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "latest gpt-5", reason: "need current info" } },
      { kind: "text", text: "Here is what I found." },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [],
    });
    expect(trace.toolCalls.map((t) => t.name)).toContain("web_search");
    expect(trace.output).toContain("Here is what I found.");
  });
});
