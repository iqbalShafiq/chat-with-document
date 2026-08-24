import {
  Agent,
  type AnyTool,
  type CompletionModel,
  type GuardrailPolicyInput,
  type MemoryStore,
} from "@anvia/core";
import type { AgentObservabilityOptions } from "@anvia/core/observability";
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

export interface CreateAgentOptions {
  agentId: string;
  model?: CompletionModel;
  reasoningEffort?: ReasoningEffort;
  maxTurns?: number;
  additionalTools?: AnyTool[];
  additionalInstructions?: string[];
  additionalContext?: AgentContextBlock[];
  observability?: AgentObservabilityOptions;
  guardrails?: GuardrailPolicyInput;
  memory?: MemoryStore;
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
  const context = (opts.additionalContext ?? []).flatMap((block, index) => {
    const text = block.text.trim();
    if (!text) return [];
    return [
      {
        id: block.id?.trim() || `context-${index}`,
        text,
      },
    ];
  });

  return new Agent({
    id: opts.agentId,
    model: opts.model ?? defaultModel(),
    instructions,
    context,
    tools: [...(opts.additionalTools ?? [])],
    providerOptions: providerOptionsForReasoning(reasoningEffort),
    maxTurns: opts.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    ...(opts.memory
      ? { memory: { store: opts.memory, savePolicy: "turn" as const } }
      : {}),
    ...(opts.mcpServers?.length ? { mcpServers: [...opts.mcpServers] } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.guardrails !== undefined ? { guardrails: opts.guardrails } : {}),
  });
}
