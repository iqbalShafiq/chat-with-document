import {
  Agent,
  type AnyTool,
  type CompletionModel,
  type GuardrailPolicyInput,
  type MemoryOptions,
  type MemoryStore,
} from "@anvia/core";
import type { AgentObservabilityOptions } from "@anvia/core/observability";
import type { AgentContextInput as NativeAgentContextInput } from "@anvia/core/agent";
import type { McpServer } from "@anvia/core/mcp";
import {
  DEFAULT_REASONING_EFFORT,
  defaultModel,
  providerOptionsForReasoning,
  type ReasoningEffort,
} from "./providers/openai.js";
import { BASE_INSTRUCTIONS } from "./prompts/base-instructions.js";

export const DEFAULT_AGENT_MAX_TURNS = 20;

export type AgentContextBlock = {
  text: string;
  id?: string;
};
export type AgentContextInput = NativeAgentContextInput;

/**
 * Declarative memory policy passed to Anvia v1. The store and every native
 * compaction option stay process-local; only the policy values are resolved
 * by the caller and may be reconstructed from a durable run recipe.
 */
export type CreateAgentMemoryOptions = MemoryOptions & {
  store: MemoryStore;
};

export interface CreateAgentOptions {
  agentId: string;
  model?: CompletionModel;
  reasoningEffort?: ReasoningEffort;
  maxTurns?: number;
  additionalTools?: AnyTool[];
  additionalInstructions?: string[];
  additionalContext?: AgentContextBlock[];
  context?: readonly AgentContextInput[];
  observability?: AgentObservabilityOptions;
  guardrails?: GuardrailPolicyInput;
  memory?: MemoryStore | CreateAgentMemoryOptions;
  mcpServers?: McpServer[];
}

export function createAgent(opts: CreateAgentOptions): Agent {
  const reasoningEffort = opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const instructions = [
    BASE_INSTRUCTIONS,
    ...(opts.additionalInstructions ?? []),
  ]
    .map((instruction) => instruction.trim())
    .filter(Boolean)
    .join("\n\n");
  const convenienceContext = (opts.additionalContext ?? []).flatMap((block, index) => {
    const text = block.text.trim();
    if (!text) return [];
    return [
      {
        id: block.id?.trim() || `context-${index}`,
        text,
      },
    ];
  });

  const memory = opts.memory === undefined
    ? undefined
    : isMemoryOptions(opts.memory)
      ? opts.memory
      : { store: opts.memory, savePolicy: "turn" as const };

  return new Agent({
    id: opts.agentId,
    model: opts.model ?? defaultModel(),
    instructions,
    context: [...(opts.context ?? []), ...convenienceContext],
    tools: [...(opts.additionalTools ?? [])],
    providerOptions: providerOptionsForReasoning(reasoningEffort),
    maxTurns: opts.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    ...(memory ? { memory } : {}),
    ...(opts.mcpServers?.length ? { mcpServers: [...opts.mcpServers] } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.guardrails !== undefined ? { guardrails: opts.guardrails } : {}),
  });
}

function isMemoryOptions(
  value: MemoryStore | CreateAgentMemoryOptions,
): value is CreateAgentMemoryOptions {
  return typeof value === "object" && value !== null && "store" in value;
}
