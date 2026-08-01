import {
  AgentBuilder,
  type AnyTool,
  type CompletionModel,
  type MemoryStore,
} from "@anvia/core";
import type { LangfuseTracing } from "@anvia/langfuse";
import {
  DEFAULT_REASONING_EFFORT,
  defaultModel,
  type ReasoningEffort,
} from "./providers/openai.js";
import { BASE_INSTRUCTIONS } from "./prompts/base-instructions.js";

interface CreateAgentOptions {
  agentId: string;
  model?: CompletionModel;
  reasoningEffort?: ReasoningEffort;
  additionalTools?: AnyTool[];
  additionalInstructions?: string[];
  tracing: LangfuseTracing;
  memory?: MemoryStore;
}

export function createAgent(
  opts: CreateAgentOptions,
): ReturnType<AgentBuilder["build"]> {
  const reasoningEffort = opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT;

  const agent = new AgentBuilder(opts.agentId, opts.model ?? defaultModel)
    .instructions(BASE_INSTRUCTIONS)
    .tools([...(opts.additionalTools ?? [])])
    .additionalParams({
      reasoning: {
        effort: reasoningEffort,
        summary: "auto",
      },
      include: ["reasoning.encrypted_content"],
    })
    .observe(opts.tracing);

  for (const instruction of opts.additionalInstructions ?? []) {
    agent.instructions(instruction);
  }

  if (opts.memory) {
    agent.memory(opts.memory);
  }

  return agent.build();
}
