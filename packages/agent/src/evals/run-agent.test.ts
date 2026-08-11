import { describe, expect, it } from "vitest";
import type { LangfuseTracing } from "@anvia/langfuse";
import { createScriptedCompletionModel } from "./stub-scopes.js";
import { runAgentAndCollect } from "./run-agent.js";

function fakeTracing(run: {
  runTrace?: { traceId: string; observationId?: string };
  currentTrace?: { traceId: string; observationId?: string };
}): LangfuseTracing {
  return {
    startRun: () =>
      run.runTrace
        ? { trace: run.runTrace, end: async () => {} }
        : undefined,
    getCurrentTrace: () =>
      run.currentTrace
        ? {
            traceId: run.currentTrace.traceId,
            observationId: run.currentTrace.observationId ?? "",
            addAttributes: () => {},
            addEvent: () => {},
          }
        : undefined,
  } as unknown as LangfuseTracing;
}

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
    expect(trace.trace).toBeUndefined();
  });

  it("records the run trace from the observer when tracing is provided", async () => {
    const model = createScriptedCompletionModel([
      { kind: "text", text: "done" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "hello",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [],
      tracing: fakeTracing({
        runTrace: { traceId: "trace-1", observationId: "obs-1" },
      }),
      suiteName: "test-suite",
      caseId: "case-1",
    });
    expect(trace.trace).toEqual({
      traceId: "trace-1",
      observationId: "obs-1",
    });
  });

  it("falls back to getCurrentTrace when the run observer exposes no trace", async () => {
    const model = createScriptedCompletionModel([
      { kind: "text", text: "done" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "hello",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [],
      tracing: fakeTracing({
        currentTrace: { traceId: "trace-2", observationId: "obs-2" },
      }),
    });
    expect(trace.trace).toEqual({
      traceId: "trace-2",
      observationId: "obs-2",
    });
  });
});
