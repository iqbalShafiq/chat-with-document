import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import { createStaticToolDefinition, type ToolDefinition } from "../static-definition.js";
import { waitBudgetForTool } from "./limits.js";
import { InFlightToolRegistry, ToolCallUnknownError } from "./registry.js";
import { AWAIT_TOOL_CALL_NAME, CANCEL_TOOL_CALL_NAME } from "./types.js";
import { finishObserve, type WrapWaitBudgetDeps } from "./wrap-tool.js";

const toolCallIdInput = z.object({
  toolCallId: z.string().trim().min(1).max(200).describe("The in-flight tool call to observe"),
});

const jsonOutputSchema = z.json();

const awaitToolCallSpec = {
  name: AWAIT_TOOL_CALL_NAME,
  description:
    "Wait for another slice of work on an in-flight tool call that returned still_running. Pass the same toolCallId. Does not start a new tool. Use only after still_running. Always tell the user you are still waiting in the same turn.",
  inputSchema: toolCallIdInput,
} as const;

const cancelToolCallSpec = {
  name: CANCEL_TOOL_CALL_NAME,
  description:
    "Cancel an in-flight tool call that returned still_running. Pass the same toolCallId. Does not start a new tool. Always tell the user you stopped it in the same turn. After cancel, do not invent that tool's result.",
  inputSchema: toolCallIdInput,
} as const;

export const WAIT_BUDGET_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(awaitToolCallSpec),
  createStaticToolDefinition(cancelToolCallSpec),
];

export type AwaitCancelToolDeps = {
  registry: InFlightToolRegistry;
  sliceMsFor?: (toolName: string) => number;
  onProgress?: WrapWaitBudgetDeps["onProgress"];
};

export function createAwaitCancelTools(deps: AwaitCancelToolDeps): AnyTool[] {
  const awaitTool = createTool({
    ...awaitToolCallSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ toolCallId }) => {
      const peek = deps.registry.peek(toolCallId);
      if (!peek) throw new ToolCallUnknownError(toolCallId);
      await deps.onProgress?.({
        toolCallId,
        toolName: peek.toolName,
        phase: "awaiting",
        elapsedMs: 0,
        waitCount: 0,
        ...(peek.stage !== undefined ? { stage: peek.stage } : {}),
      });
      const sliceMs = deps.sliceMsFor?.(peek.toolName) ?? waitBudgetForTool(peek.toolName);
      const observed = await deps.registry.awaitSlice(toolCallId, sliceMs);
      return finishObserve(observed, deps, toolCallId, peek.toolName);
    },
  });

  const cancelTool = createTool({
    ...cancelToolCallSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ toolCallId }) => {
      const cancelled = deps.registry.cancel(toolCallId);
      await deps.onProgress?.({
        toolCallId: cancelled.toolCallId,
        toolName: cancelled.toolName,
        phase: "cancelled",
        elapsedMs: cancelled.elapsedMs,
        waitCount: 0,
        ...(cancelled.stage !== undefined ? { stage: cancelled.stage } : {}),
      });
      return cancelled;
    },
  });

  return [awaitTool, cancelTool];
}
