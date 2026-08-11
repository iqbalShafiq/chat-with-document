import {
  AgentBuilder,
  type AnyTool,
  type CompletionModel,
  type MemoryStore,
  type ToolApprovalsOptions,
} from "@anvia/core";
import type { AgentObserver } from "@anvia/core/observability";
import type { McpServer } from "@anvia/core/mcp";
import type { LangfuseTracing } from "@anvia/langfuse";
import {
  DEFAULT_REASONING_EFFORT,
  defaultModel,
  type ReasoningEffort,
} from "./providers/openai.js";
import { BASE_INSTRUCTIONS } from "./prompts/base-instructions.js";

export type AgentContextBlock = {
  text: string;
  id?: string;
};

interface CreateAgentOptions {
  agentId: string;
  model?: CompletionModel;
  reasoningEffort?: ReasoningEffort;
  additionalTools?: AnyTool[];
  additionalInstructions?: string[];
  /** Small request facts (e.g. project workspace name) via Anvia AgentBuilder.context */
  additionalContext?: AgentContextBlock[];
  tracing?: LangfuseTracing;
  memory?: MemoryStore;
  /** Optional approval handler (e.g. human approval for web tools). */
  approvals?: ToolApprovalsOptions;
  /** Optional MCP servers (e.g. context7) to expose to the agent. */
  mcpServers?: McpServer[];
  /** Optional run observers (e.g. tool error tracking). */
  observers?: AgentObserver[];
}

export function createAgent(
  opts: CreateAgentOptions,
): ReturnType<AgentBuilder["build"]> {
  const reasoningEffort = opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT;

  const agent = new AgentBuilder(opts.agentId, opts.model ?? defaultModel())
    .instructions(BASE_INSTRUCTIONS)
    .tools([...(opts.additionalTools ?? [])])
    .additionalParams({
      reasoning: {
        effort: reasoningEffort,
        summary: "auto",
      },
      include: ["reasoning.encrypted_content"],
    });

  if (opts.tracing) {
    agent.observe(opts.tracing);
  }

  for (const observer of opts.observers ?? []) {
    agent.observe(observer);
  }

  for (const instruction of opts.additionalInstructions ?? []) {
    agent.instructions(instruction);
  }

  for (const block of opts.additionalContext ?? []) {
    if (!block.text.trim()) continue;
    agent.context(block.text, block.id);
  }

  if (opts.memory) {
    agent.memory(opts.memory);
  }

  if (opts.approvals) {
    agent.approvals(opts.approvals);
  }

  if (opts.mcpServers && opts.mcpServers.length > 0) {
    agent.mcp(opts.mcpServers);
  }

  return agent.build();
}
