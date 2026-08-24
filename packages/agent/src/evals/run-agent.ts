import type {
  AgentOutcome,
  AnyTool,
  CompletionModel,
  GuardrailPolicyInput,
  JsonValue,
  MemoryStore,
  Message,
} from "@anvia/core";
import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import type { StreamingCompletionModel } from "@anvia/core/completion";
import type {
  AgentObserver,
  AgentObservabilityOptions,
  AgentRunObserver,
} from "@anvia/core/observability";
import type { MemoryScope } from "@anvia/core/memory";
import type { AgentContextBlock, AgentContextInput } from "../agent.js";
import { createAgent } from "../agent.js";
import { parseCitationsFromText } from "../citations/parse-citations.js";
import type { ReasoningEffort } from "../providers/openai.js";
import { evalConfig } from "./config.js";
import type { BehaviorTrace, SessionConfig } from "./types.js";

export type EvalInteractionResponder = (
  request: AgentInteractionRequest,
) => AgentInteractionResponse | Promise<AgentInteractionResponse>;

type ToolCallPart = {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
};

type EvalState = {
  toolCalls: BehaviorTrace["toolCalls"];
  approvals: BehaviorTrace["approvals"];
  clarifications: BehaviorTrace["clarifications"];
  textParts: string[];
  usage: BehaviorTrace["usage"];
  trace?: BehaviorTrace["trace"];
  outcome?: BehaviorTrace["outcome"];
  toolCallIds: Set<string>;
  erroredToolCalls: Map<string, BehaviorTrace["toolCalls"][number]>;
};

export async function runAgentAndCollect(input: {
  prompt: string;
  sessionConfig: SessionConfig;
  model?: CompletionModel;
  reasoningEffort?: ReasoningEffort;
  maxTurns?: number;
  tools: AnyTool[];
  instructions?: string[];
  contextBlocks?: AgentContextBlock[];
  context?: readonly AgentContextInput[];
  tracing?: AgentObserver;
  suiteName?: string;
  caseId?: string;
  deepResearchProgress?: string[];
  interactionResponder?: EvalInteractionResponder;
  maxInteractionResponses?: number;
  guardrails?: GuardrailPolicyInput;
  onTimeout?: () => void;
}): Promise<BehaviorTrace> {
  const started = Date.now();
  const state: EvalState = {
    toolCalls: [],
    approvals: [],
    clarifications: [],
    textParts: [],
    usage: {},
    toolCallIds: new Set(),
    erroredToolCalls: new Map(),
  };
  let closeProviderStream: (() => void) | undefined;
  let cancelActiveRun: (() => void) | undefined;
  const abortController = new AbortController();
  const model = input.model
    ? wrapStreamingModel(input.model, (close) => {
        closeProviderStream = close;
      })
    : undefined;
  const observability = createEvalObservability(input.tracing, state.erroredToolCalls);

  const agent = createAgent({
    agentId: "eval-agent",
    ...(model ? { model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    additionalInstructions: input.instructions ?? [],
    additionalContext: input.contextBlocks ?? [],
    ...(input.context ? { context: input.context } : {}),
    additionalTools: input.tools,
    memory: createInMemoryMemoryStore(),
    observability,
    ...(input.guardrails !== undefined ? { guardrails: input.guardrails } : {}),
  });

  const collect = (async () => {
    const trace = input.tracing
      ? {
          ...(input.suiteName ? { name: input.suiteName } : {}),
          userId: "eval-user",
          sessionId: "eval-session",
          metadata: {
            ...(input.caseId ? { caseId: input.caseId } : {}),
            ...(input.suiteName ? { suiteName: input.suiteName } : {}),
          },
        }
      : undefined;
    const stream = agent.stream({
      prompt: input.prompt,
      session: { sessionId: "eval-session", userId: "eval-user" },
      abortSignal: abortController.signal,
      ...(trace ? { trace } : {}),
    });
    const iterator = stream[Symbol.asyncIterator]();
    cancelActiveRun = () => {
      abortController.abort("eval timeout");
      stream.cancel("eval timeout");
      closeAsyncIterator(iterator);
    };

    let outcome = await collectStream(iterator, stream.result, state);
    recordTerminalOutcome(outcome, state, true);
    let responseCount = 0;
    const maxResponses = input.maxInteractionResponses ?? 8;
    while (outcome.type === "interaction") {
      recordInteraction(outcome.interaction, state);
      if (!input.interactionResponder || responseCount >= maxResponses) break;
      responseCount += 1;
      const response = await input.interactionResponder(outcome.interaction);
      recordInteractionResponse(outcome.interaction, response, state);
      const resumeTrace = trace
        ? {
            ...trace,
            ...(state.trace?.traceId ? { traceId: state.trace.traceId } : {}),
          }
        : undefined;
      outcome = await agent.resume(outcome.continuation, response, {
        abortSignal: abortController.signal,
        ...(resumeTrace ? { trace: resumeTrace } : {}),
      });
      collectResumedOutcome(outcome, state);
    }

    if (state.outcome === undefined) {
      throw new Error("Agent outcome was not recorded.");
    }
    const output = state.textParts.join("");
    const citations: BehaviorTrace["citations"] = parseCitationsFromText(
      output,
    ).citations.map((citation) => ({ source: citation.filename }));

    return {
      outcome: state.outcome,
      output,
      toolCalls: state.toolCalls,
      approvals: state.approvals,
      clarifications: state.clarifications,
      citations,
      ...(input.deepResearchProgress
        ? { deepResearchProgress: input.deepResearchProgress }
        : {}),
      usage: state.usage,
      durationMs: Date.now() - started,
      ...(state.trace ? { trace: state.trace } : {}),
    };
  })();

  return await runWithTimeout(collect, evalConfig.timeoutMs, () => {
    cancelActiveRun?.();
    closeProviderStream?.();
    input.onTimeout?.();
  });
}

export function createCancellableCompletionModel(model: CompletionModel): {
  model: CompletionModel;
  cancel: () => void;
} {
  let closeProviderStream: (() => void) | undefined;
  return {
    model: wrapStreamingModel(model, (close) => {
      closeProviderStream = close;
    }),
    cancel: () => closeProviderStream?.(),
  };
}

async function collectStream(
  iterator: AsyncIterator<unknown>,
  result: Promise<AgentOutcome<string>>,
  state: EvalState,
): Promise<AgentOutcome<string>> {
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    handleStreamEvent(next.value, state);
  }
  return await result;
}

function handleStreamEvent(event: unknown, state: EvalState, includeText = true): void {
  if (!isRecord(event) || typeof event.type !== "string") return;
  switch (event.type) {
    case "text_delta":
      if (includeText && typeof event.delta === "string") state.textParts.push(event.delta);
      return;
    case "tool_call":
      if (isToolCallPart(event.toolCall)) recordToolCall(event.toolCall, state);
      return;
    case "agent_tool_event":
      handleStreamEvent(event.event, state, false);
      return;
    case "error":
      throw event.error;
    default:
      return;
  }
}

function collectResumedOutcome(outcome: AgentOutcome<string>, state: EvalState): void {
  for (const message of outcome.messages) recordMessageToolCalls(message, state);
  if (outcome.text) state.textParts.push(outcome.text);
  recordTerminalOutcome(outcome, state, false);
}

function recordTerminalOutcome(
  outcome: AgentOutcome<string>,
  state: EvalState,
  includeText: boolean,
): void {
  state.outcome = behaviorOutcomeOf(outcome);
  state.usage = {
    inputTokens: (state.usage.inputTokens ?? 0) + outcome.usage.inputTokens,
    outputTokens: (state.usage.outputTokens ?? 0) + outcome.usage.outputTokens,
  };
  if (outcome.trace?.traceId) {
    const observationId = outcome.trace.observationId ?? state.trace?.observationId;
    state.trace = {
      traceId: state.trace?.traceId ?? outcome.trace.traceId,
      ...(observationId ? { observationId } : {}),
    };
  }
  if (includeText && outcome.text && state.textParts.length === 0) {
    state.textParts.push(outcome.text);
  }
}

function recordInteraction(request: AgentInteractionRequest, state: EvalState): void {
  if (request.type === "tool-approval") {
    const pending = findPendingToolCall(request.toolName, state.toolCalls);
    if (pending) pending.status = "approval_requested";
    state.approvals.push({
      toolName: request.toolName,
      reason: request.reason ?? "",
      decision: "none",
    });
    return;
  }

  state.clarifications.push({
    questions: request.questions.map((question) => ({
      id: question.id,
      question: question.text,
      type: question.choices ? "choice" : "free_text",
    })),
  });
}

function recordInteractionResponse(
  request: AgentInteractionRequest,
  response: AgentInteractionResponse,
  state: EvalState,
): void {
  if (request.type !== "tool-approval" || response.type !== "tool-approval") return;
  const decision = response.approved ? "approved" : "rejected";
  const approval = [...state.approvals]
    .reverse()
    .find((item) => item.toolName === request.toolName && item.decision === "none");
  if (approval) approval.decision = decision;
  const pending = findPendingToolCall(request.toolName, state.toolCalls);
  if (pending) pending.status = decision;
}

function recordToolCall(toolCall: ToolCallPart, state: EvalState): void {
  if (state.toolCallIds.has(toolCall.toolCallId)) return;
  state.toolCallIds.add(toolCall.toolCallId);
  const record = {
    name: toolCall.toolName,
    args: toArgs(toolCall.input),
    status: "called" as const,
  };
  state.toolCalls.push(record);
  state.erroredToolCalls.set(toolCall.toolCallId, record);
}

function recordMessageToolCalls(message: Message, state: EvalState): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part.type === "tool-call" && isToolCallPart(part)) recordToolCall(part, state);
  }
}

function findPendingToolCall(
  toolName: string,
  toolCalls: BehaviorTrace["toolCalls"],
): BehaviorTrace["toolCalls"][number] | undefined {
  return [...toolCalls]
    .reverse()
    .find(
      (call) =>
        call.name === toolName &&
        (call.status === "called" || call.status === "approval_requested"),
    );
}

function toArgs(value: JsonValue): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : { __raw: value };
    } catch {
      return { __raw: value };
    }
  }
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallPart(value: unknown): value is ToolCallPart {
  return (
    isRecord(value) &&
    value.type === "tool-call" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isJsonValue(value.input)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function createEvalObservability(
  tracing: AgentObserver | undefined,
  erroredToolCalls: Map<string, BehaviorTrace["toolCalls"][number]>,
): AgentObservabilityOptions {
  const observers: Record<string, AgentObserver> = {
    eval: createToolErrorObserver(erroredToolCalls),
  };
  if (tracing) observers.langfuse = tracing;
  return {
    observers,
    primaryTrace: tracing ? "langfuse" : "eval",
    errorPolicy: "ignore",
  };
}

function behaviorOutcomeOf(outcome: AgentOutcome<string>): BehaviorTrace["outcome"] {
  switch (outcome.type) {
    case "response":
      return { type: "response" };
    case "interaction":
      return {
        type: "interaction",
        interactionType: outcome.interaction.type,
      };
    case "blocked":
      return {
        type: "blocked",
        stage: outcome.stage,
        reason: outcome.reason,
      };
  }
}

function createToolErrorObserver(
  erroredToolCalls: Map<string, BehaviorTrace["toolCalls"][number]>,
): AgentObserver {
  return {
    startRun: (): AgentRunObserver => ({
      startTool: (args) => {
        const key = args.toolCall.toolCallId;
        return {
          end: async () => {},
          error: async ({ error }) => {
            const record = erroredToolCalls.get(key);
            if (record && record.status !== "rejected" && record.status !== "error") {
              record.status = "error";
              record.error = error instanceof Error ? error.message : String(error);
            }
          },
        };
      },
      end: async () => {},
    }),
  };
}

function createInMemoryMemoryStore(): MemoryStore {
  const messagesByScope = new Map<string, Message[]>();
  const scopeKey = (scope: MemoryScope): string =>
    `${scope.sessionId}::${scope.userId ?? ""}`;
  return {
    async load({ scope }) {
      return messagesByScope.get(scopeKey(scope)) ?? [];
    },
    async append({ scope, messages }) {
      const key = scopeKey(scope);
      messagesByScope.set(key, [...(messagesByScope.get(key) ?? []), ...messages]);
    },
    async clear({ scope }) {
      messagesByScope.delete(scopeKey(scope));
    },
    async recordError() {},
  };
}

async function runWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        onTimeout?.();
        reject(new Error(`Eval case timed out after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function closeAsyncIterator(iterator: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  } catch {
    // A provider's iterator may throw while closing; timeout handling must still return.
  }
}

function wrapStreamingModel(
  model: CompletionModel,
  registerClose: (close: () => void) => void,
): CompletionModel {
  if (!("streamCompletion" in model) || typeof model.streamCompletion !== "function") {
    return model;
  }
  const streamingModel = model as StreamingCompletionModel;
  const wrapped: StreamingCompletionModel = {
    ...model,
    streamCompletion(request, options) {
      const source = streamingModel.streamCompletion(request, options);
      const iterator = source[Symbol.asyncIterator]();
      registerClose(() => closeAsyncIterator(iterator));
      return {
        [Symbol.asyncIterator]: () => iterator,
      };
    },
  };
  return wrapped;
}
