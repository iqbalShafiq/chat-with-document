import {
  createTool,
  defineGuardrailPolicy,
  guardrails,
  type AnyTool,
} from "@anvia/core";
import { createQuestionTool } from "@anvia/core/tool";
import { describe, expect, it } from "vitest";
import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type {
  CompletionResponse,
  StreamingCompletionModel,
} from "@anvia/core/completion";
import type {
  AgentObserver,
  AgentRunObserver,
} from "@anvia/core/observability";
import { createScriptedCompletionModel } from "./stub-scopes.js";
import {
  createEvalObservability,
  runAgentAndCollect,
  type EvalInteractionResponder,
} from "./run-agent.js";
import { z } from "zod";

function webSearchFixture(options: {
  requiresApproval?: () => { reason: string };
  execute?: () => string | Promise<string>;
} = {}): AnyTool {
  return createTool({
    name: "web_search",
    description: "search",
    inputSchema: z.object({ query: z.string().optional(), reason: z.string().optional() }),
    ...(options.requiresApproval ? { requiresApproval: options.requiresApproval } : {}),
    execute: options.execute ?? (async () => "fixture result"),
  });
}

function fakeTracing(traceId: string, observationId?: string): AgentObserver {
  return {
    startRun: (): AgentRunObserver => ({
      trace: { traceId, ...(observationId ? { observationId } : {}) },
      end: async () => {},
    }),
  };
}

function traceContinuityObserver(traceIds: Array<string | undefined>): AgentObserver {
  let observation = 0;
  return {
    startRun: (args) => {
      traceIds.push(args.trace?.traceId);
      observation += 1;
      return {
        trace: {
          traceId: args.trace?.traceId ?? "trace-root",
          observationId: `observation-${observation}`,
        },
        end: async () => {},
      };
    },
  };
}

function approvalResponder(
  approved: boolean,
  seen: AgentInteractionRequest[] = [],
): EvalInteractionResponder {
  return async (request): Promise<AgentInteractionResponse> => {
    seen.push(request);
    if (request.type === "tool-approval") {
      return {
        type: "tool-approval",
        approved,
        ...(approved ? {} : { reason: "fixture rejection" }),
      };
    }
    return {
      type: "tool-question",
      answers: request.questions.map((question) => ({
        questionId: question.id,
        value: "fixture answer",
      })),
    };
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
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
      tools: [webSearchFixture()],
      interactionResponder: approvalResponder(true),
    });
    expect(trace.toolCalls.map((t) => t.name)).toContain("web_search");
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.output).toContain("Here is what I found.");
    expect(trace.outcome).toEqual({ type: "response" });
    expect(trace.trace).toBeUndefined();
  });

  it("registers Langfuse tracing under the canonical observer name", async () => {
    const tracing = fakeTracing("trace-canonical");
    const options = createEvalObservability(tracing, new Map());
    expect(options.primaryTrace).toBe("langfuse");
    expect(options.observers.langfuse).toBe(tracing);
    expect(options.observers).not.toHaveProperty("tracing");
  });

  it("records the native run trace from the observer when tracing is provided", async () => {
    const model = createScriptedCompletionModel([
      { kind: "text", text: "done" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "hello",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [],
      tracing: fakeTracing("trace-1", "obs-1"),
      suiteName: "test-suite",
      caseId: "case-1",
    });
    expect(trace.trace).toEqual({
      traceId: "trace-1",
      observationId: "obs-1",
    });
  });

  it("keeps a response outcome when the native observer has no trace", async () => {
    const model = createScriptedCompletionModel([
      { kind: "text", text: "done" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "hello",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [],
      tracing: fakeTracing("trace-2", "obs-2"),
    });
    expect(trace.trace).toEqual({
      traceId: "trace-2",
      observationId: "obs-2",
    });
  });

  it("records a suspended native approval interaction without waiting forever", async () => {
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "latest gpt-5" } },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
    });
    expect(trace.approvals).toEqual([
      {
        toolName: "web_search",
        reason: "fixture approval",
        decision: "none",
      },
    ]);
    expect(trace.output).toBe("");
    expect(trace.outcome).toEqual({
      type: "interaction",
      interactionType: "tool-approval",
    });
  });

  it("resumes a native approval interaction and records its decision", async () => {
    const seen: AgentInteractionRequest[] = [];
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "latest gpt-5" } },
      { kind: "text", text: "approved result" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
      interactionResponder: approvalResponder(true, seen),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("tool-approval");
    expect(trace.approvals).toEqual([
      {
        toolName: "web_search",
        reason: "fixture approval",
        decision: "approved",
      },
    ]);
    expect(trace.output).toContain("approved result");
    expect(trace.outcome).toEqual({ type: "response" });
  });

  it("marks an approved tool as error when execution fails after approval", async () => {
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "latest gpt-5" } },
      { kind: "text", text: "search failed" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [
        webSearchFixture({
          requiresApproval: () => ({ reason: "fixture approval" }),
          execute: async () => {
            throw new Error("approved fixture tool failure");
          },
        }),
      ],
      interactionResponder: approvalResponder(true),
    });
    const record = trace.toolCalls.find((toolCall) => toolCall.name === "web_search");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("approved fixture tool failure");
  });

  it("keeps one canonical trace root across native resume", async () => {
    const traceIds: Array<string | undefined> = [];
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "latest gpt-5" } },
      { kind: "text", text: "approved result" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
      tracing: traceContinuityObserver(traceIds),
      interactionResponder: approvalResponder(true),
    });

    expect(traceIds).toEqual([undefined, "trace-root"]);
    expect(trace.trace?.traceId).toBe("trace-root");
  });

  it("records a rejected approval and still returns a response outcome", async () => {
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "latest gpt-5" } },
      { kind: "text", text: "I could not search without approval." },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
      interactionResponder: approvalResponder(false),
    });
    expect(trace.approvals.at(-1)?.decision).toBe("rejected");
    expect(trace.outcome).toEqual({ type: "response" });
  });

  it("records a question interaction and its resumed response outcome", async () => {
    const model = createScriptedCompletionModel([
      {
        kind: "tool_call",
        name: "request_clarification",
        args: { questions: [{ id: "style", text: "Which style?" }] },
      },
      { kind: "text", text: "The selected style is fixture answer." },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "choose a style",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [
        createQuestionTool({
          name: "request_clarification",
          description: "Ask a fixture question.",
        }),
      ],
      interactionResponder: approvalResponder(true),
    });
    expect(trace.clarifications).toHaveLength(1);
    expect(trace.outcome).toEqual({ type: "response" });
  });

  it("counts each native outcome usage exactly once", async () => {
    const model = createScriptedCompletionModel([
      {
        kind: "tool_call",
        name: "web_search",
        args: { query: "latest gpt-5" },
        usage: usage(3, 2),
      },
      { kind: "text", text: "approved result", usage: usage(7, 11) },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search the web for gpt-5",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
      interactionResponder: approvalResponder(true),
    });
    expect(trace.usage).toMatchObject({ inputTokens: 10, outputTokens: 13 });
  });

  it("deduplicates resumed tool calls by native toolCallId", async () => {
    const model = createScriptedCompletionModel([
      {
        kind: "tool_call",
        name: "web_search",
        toolCallId: "same-native-call",
        args: { query: "latest gpt-5" },
      },
      {
        kind: "tool_call",
        name: "web_search",
        toolCallId: "same-native-call",
        args: { query: "latest gpt-5 again" },
      },
      { kind: "text", text: "done" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search twice",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
      interactionResponder: approvalResponder(true),
    });
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0]?.args).toEqual({ query: "latest gpt-5" });
  });

  it("records native blocked outcomes distinctly", async () => {
    const model = createScriptedCompletionModel([{ kind: "text", text: "never emitted" }]);
    const trace = await runAgentAndCollect({
      prompt: "blocked prompt",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [],
      guardrails: defineGuardrailPolicy({
        id: "eval-block",
        input: [
          guardrails.blockText({
            id: "block-input",
            boundary: "input",
            patterns: [/.+/],
            reason: "fixture blocked",
            message: "Blocked by fixture guardrail.",
          }),
        ],
      }),
    });
    expect(trace.outcome).toEqual({
      type: "blocked",
      stage: "input",
      reason: "fixture blocked",
    });
  });

  it("aborts an active resumed generation when the eval times out", async () => {
    let resumedAbort = false;
    const initialToolCall = {
      type: "tool-call" as const,
      toolCallId: "timeout-tool-call",
      toolName: "web_search",
      input: { query: "latest gpt-5" },
    };
    const initialResponse: CompletionResponse = {
      choice: [initialToolCall],
      usage: usage(1, 1),
      rawResponse: {},
    };
    const hangingResumeModel: StreamingCompletionModel = {
      provider: "hanging-resume",
      modelId: "hanging-resume",
      capabilities: {
        streaming: true,
        tools: true,
        toolChoice: false,
        imageInput: false,
        documentInput: false,
        outputSchema: false,
        reasoning: false,
      },
      completion: (_request, options) =>
        new Promise<CompletionResponse>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) return;
          signal.addEventListener(
            "abort",
            () => {
              resumedAbort = true;
              reject(signal.reason ?? new Error("resumed generation aborted"));
            },
            { once: true },
          );
        }),
      async *streamCompletion() {
        yield { type: "tool_call", toolCall: initialToolCall };
        yield { type: "final", response: initialResponse };
      },
    };

    process.env.EVAL_TIMEOUT_MS = "50";
    try {
      await expect(
        runAgentAndCollect({
          prompt: "search the web for gpt-5",
          sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
          model: hangingResumeModel,
          tools: [webSearchFixture({ requiresApproval: () => ({ reason: "fixture approval" }) })],
          interactionResponder: approvalResponder(true),
        }),
      ).rejects.toThrow(/Eval case timed out after 50ms/);
      expect(resumedAbort).toBe(true);
    } finally {
      delete process.env.EVAL_TIMEOUT_MS;
    }
  });

  it("rejects with a timeout error when the agent exceeds EVAL_TIMEOUT_MS", async () => {
    const hangingModel: StreamingCompletionModel = {
      provider: "hanging",
      modelId: "hanging",
      capabilities: {
        streaming: true,
        tools: true,
        toolChoice: false,
        imageInput: false,
        documentInput: false,
        outputSchema: false,
        reasoning: false,
      },
      completion: () => new Promise(() => {}),
      async *streamCompletion() {
        await new Promise(() => {});
      },
    };
    process.env.EVAL_TIMEOUT_MS = "50";
    try {
      await expect(
        runAgentAndCollect({
          prompt: "hello",
          sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
          model: hangingModel,
          tools: [],
        }),
      ).rejects.toThrow(/Eval case timed out after 50ms/);
    } finally {
      delete process.env.EVAL_TIMEOUT_MS;
    }
  });

  it("closes the provider stream iterator when an eval times out", async () => {
    let iteratorClosed = false;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<never>(() => {}),
          return: async () => {
            iteratorClosed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const hangingModel: StreamingCompletionModel = {
      provider: "hanging",
      modelId: "hanging",
      capabilities: {
        streaming: true,
        tools: true,
        toolChoice: false,
        imageInput: false,
        documentInput: false,
        outputSchema: false,
        reasoning: false,
      },
      completion: () => new Promise(() => {}),
      streamCompletion: () => stream,
    };
    process.env.EVAL_TIMEOUT_MS = "50";
    try {
      await expect(
        runAgentAndCollect({
          prompt: "hello",
          sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
          model: hangingModel,
          tools: [],
        }),
      ).rejects.toThrow(/Eval case timed out after 50ms/);
      expect(iteratorClosed).toBe(true);
    } finally {
      delete process.env.EVAL_TIMEOUT_MS;
    }
  });

  it("marks an errored tool call with status error", async () => {
    const model = createScriptedCompletionModel([
      { kind: "tool_call", name: "web_search", args: { query: "x", reason: "y" } },
      { kind: "text", text: "done" },
    ]);
    const trace = await runAgentAndCollect({
      prompt: "search",
      sessionConfig: { webSearchEnabled: false, imageGenEnabled: false, hasDocuments: false },
      model,
      tools: [webSearchFixture({
        execute: async () => {
          throw new Error("fixture tool failure");
        },
      })],
    });
    const record = trace.toolCalls.find((t) => t.name === "web_search");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("fixture tool failure");
  });
});
