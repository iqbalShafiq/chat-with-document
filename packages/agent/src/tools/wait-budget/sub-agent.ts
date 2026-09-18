import { createMiddleware, type AgentMiddleware, type AnyTool } from "@anvia/core";
import { createAwaitCancelTools } from "./await-cancel-tools.js";
import { InFlightToolRegistry } from "./registry.js";
import { SUB_AGENT_TOOL_WAIT_INSTRUCTION } from "../../prompts/tool-wait-instructions.js";
import { createToolCallIdGate, wrapToolsWithWaitBudget } from "./wrap-tool.js";

export type SubAgentWaitBudgetOptions = {
  registry?: InFlightToolRegistry;
  sliceMsFor?: (toolName: string) => number;
};

/**
 * A nested-Agent wait budget: same in-flight registry and slice policy the
 * parent agent uses, packaged so any sub-agent can give its own tools a
 * per-call checkpoint instead of blocking until they finish.
 *
 * The sub-agent keeps its own registry, so a stop request on the parent run
 * still reaches nested work through the forwarded `abortSignal` rather than
 * through id sharing.
 */
export type SubAgentWaitBudget = {
  readonly registry: InFlightToolRegistry;
  /** Wrap the sub-agent's own tools with the escalating wait budget. */
  wrapTools(tools: readonly AnyTool[]): AnyTool[];
  /** await_tool_call / cancel_tool_call for the wrapped tools. */
  controlTools(): AnyTool[];
  /** Records Anvia's unique internalCallId as the wait job id. */
  middleware(): AgentMiddleware;
  /** Sub-agent-specific wait guidance (no user-facing narration). */
  readonly instructions: string;
  /** Abort every still-running nested job, e.g. when the sub-agent returns. */
  abortOutstanding(reason: string): void;
};

export function createSubAgentWaitBudget(
  options: SubAgentWaitBudgetOptions = {},
): SubAgentWaitBudget {
  const registry = options.registry ?? new InFlightToolRegistry();
  const ids = createToolCallIdGate();
  const wrapDeps = {
    registry,
    ids,
    ...(options.sliceMsFor ? { sliceMsFor: options.sliceMsFor } : {}),
  };
  const controlDeps = {
    registry,
    ...(options.sliceMsFor ? { sliceMsFor: options.sliceMsFor } : {}),
  };

  return {
    registry,
    wrapTools: (tools) => wrapToolsWithWaitBudget(tools, wrapDeps),
    controlTools: () => createAwaitCancelTools(controlDeps),
    middleware: () =>
      createMiddleware({
        onToolInput: ({ toolName, toolCallId, internalCallId }) => {
          if (toolCallId || internalCallId) {
            ids.note(toolName, toolCallId, internalCallId);
          }
          return undefined;
        },
      }),
    instructions: SUB_AGENT_TOOL_WAIT_INSTRUCTION,
    abortOutstanding: (reason) => registry.abortAll(reason),
  };
}
