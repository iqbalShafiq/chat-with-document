import type {
  AnyTool,
  CompletionModel,
  JsonValue,
  MemoryStore,
  Message,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalsOptions,
} from "@anvia/core";
import type { MemoryContext } from "@anvia/core/memory";
import type { AgentContextBlock } from "../agent.js";
import { createAgent } from "../agent.js";
import { parseCitationsFromText } from "../citations/parse-citations.js";
import type { ReasoningEffort } from "../providers/openai.js";
import type { BehaviorTrace, ClarificationRecord, SessionConfig } from "./types.js";

export async function runAgentAndCollect(input: {
  prompt: string;
  sessionConfig: SessionConfig;
  model?: CompletionModel;
  reasoningEffort?: ReasoningEffort;
  tools: AnyTool[];
  instructions?: string[];
  contextBlocks?: AgentContextBlock[];
  approvals?: ToolApprovalsOptions;
}): Promise<BehaviorTrace> {
  const started = Date.now();
  const toolCalls: BehaviorTrace["toolCalls"] = [];
  const approvals: BehaviorTrace["approvals"] = [];
  const clarifications: BehaviorTrace["clarifications"] = [];
  const textParts: string[] = [];
  let usage: BehaviorTrace["usage"] = {};

  const agent = createAgent({
    agentId: "eval-agent",
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    additionalInstructions: input.instructions ?? [],
    additionalContext: input.contextBlocks ?? [],
    additionalTools: input.tools,
    memory: createInMemoryMemoryStore(),
    ...(input.approvals
      ? { approvals: instrumentApprovals(input.approvals, toolCalls, approvals) }
      : {}),
  });

  const stream = agent.session("eval-session").prompt(input.prompt).stream();

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        textParts.push(event.delta);
        break;
      case "tool_call":
        recordToolCall(event.toolCall, toolCalls, clarifications);
        break;
      case "final":
        usage = { ...event.usage };
        break;
      default:
        break;
    }
  }

  const output = textParts.join("");
  const citations: BehaviorTrace["citations"] = parseCitationsFromText(
    output,
  ).citations.map((citation) => ({ source: citation.filename }));

  return {
    output,
    toolCalls,
    approvals,
    clarifications,
    citations,
    usage,
    durationMs: Date.now() - started,
  };
}

function recordToolCall(
  toolCall: { id: string; function: { name: string; arguments: JsonValue } },
  toolCalls: BehaviorTrace["toolCalls"],
  clarifications: BehaviorTrace["clarifications"],
): void {
  const args = toArgs(toolCall.function.arguments);
  toolCalls.push({ name: toolCall.function.name, args, status: "called" });
  if (toolCall.function.name !== "request_clarification") return;
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const record: ClarificationRecord = {
    questions: questions.map((question) => {
      const value =
        typeof question === "object" && question !== null ? question : {};
      return {
        id: String(value.id ?? ""),
        question: String(value.question ?? ""),
        type: String(value.type ?? "free_text"),
      };
    }),
  };
  if (typeof args.title === "string") record.title = args.title;
  clarifications.push(record);
}

function toArgs(argumentsValue: JsonValue): Record<string, unknown> {
  if (typeof argumentsValue === "string") {
    try {
      return JSON.parse(argumentsValue) as Record<string, unknown>;
    } catch {
      return { __raw: argumentsValue };
    }
  }
  if (
    typeof argumentsValue === "object" &&
    argumentsValue !== null &&
    !Array.isArray(argumentsValue)
  ) {
    return argumentsValue as Record<string, unknown>;
  }
  return {};
}

function instrumentApprovals(
  options: ToolApprovalsOptions,
  toolCalls: BehaviorTrace["toolCalls"],
  approvals: BehaviorTrace["approvals"],
): ToolApprovalsOptions {
  return {
    handler: async (request: ToolApprovalRequest) => {
      const pending = [...toolCalls]
        .reverse()
        .find(
          (call) =>
            call.name === request.toolName &&
            (call.status === "called" || call.status === "approval_requested"),
        );
      if (pending) pending.status = "approval_requested";
      const decision = await options.handler(request);
      const outcome = approvalDecisionOf(decision);
      if (pending) pending.status = outcome;
      approvals.push({
        toolName: request.toolName,
        reason: request.reason ?? "",
        decision: outcome,
      });
      return decision;
    },
  };
}

function approvalDecisionOf(decision: ToolApprovalDecision): "approved" | "rejected" {
  if (typeof decision === "boolean") {
    return decision ? "approved" : "rejected";
  }
  return decision.approved ? "approved" : "rejected";
}

function createInMemoryMemoryStore(): MemoryStore {
  const messagesByScope = new Map<string, Message[]>();
  const scopeKey = (context: MemoryContext): string =>
    `${context.sessionId}::${context.userId ?? ""}`;
  return {
    async load(context) {
      return messagesByScope.get(scopeKey(context)) ?? [];
    },
    async append(input) {
      const key = scopeKey(input.context);
      messagesByScope.set(key, [
        ...(messagesByScope.get(key) ?? []),
        ...input.messages,
      ]);
    },
    async clear(context) {
      messagesByScope.delete(scopeKey(context));
    },
    async recordError() {},
  };
}
