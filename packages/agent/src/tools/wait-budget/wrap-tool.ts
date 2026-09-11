import { randomUUID } from "node:crypto";
import type { AnyTool, ToolCallContext } from "@anvia/core";
import { waitBudgetForTool } from "./limits.js";
import { InFlightToolRegistry, type ObserveResult } from "./registry.js";
import { isControlToolName, type ToolWaitProgress } from "./types.js";

export type ToolCallIdGate = {
  note(toolName: string, toolCallId: string): void;
  take(toolName: string): string | undefined;
};

export function createToolCallIdGate(): ToolCallIdGate {
  const queues = new Map<string, string[]>();
  return {
    note(toolName, toolCallId) {
      const queue = queues.get(toolName) ?? [];
      queue.push(toolCallId);
      queues.set(toolName, queue);
    },
    take(toolName) {
      const queue = queues.get(toolName);
      return queue?.shift();
    },
  };
}

export type WrapWaitBudgetDeps = {
  registry: InFlightToolRegistry;
  ids?: ToolCallIdGate;
  nextId?: () => string;
  sliceMsFor?: (toolName: string) => number;
  onProgress?: (event: ToolWaitProgress) => void | Promise<void>;
};

export function wrapToolsWithWaitBudget(
  tools: readonly AnyTool[],
  deps: WrapWaitBudgetDeps,
): AnyTool[] {
  return tools.map((tool) =>
    isControlToolName(tool.name) ? tool : wrapToolWithWaitBudget(tool, deps),
  );
}

export function wrapToolWithWaitBudget(tool: AnyTool, deps: WrapWaitBudgetDeps): AnyTool {
  if (isControlToolName(tool.name)) return tool;
  const wrapped: AnyTool = {
    name: tool.name,
    definition: (prompt) => tool.definition(prompt),
    call: async (args, context) => {
      const toolCallId = deps.ids?.take(tool.name) ?? deps.nextId?.() ?? randomUUID();
      await emitProgress(deps, {
        toolCallId,
        toolName: tool.name,
        phase: "running",
        elapsedMs: 0,
        waitCount: 0,
      });
      const sliceMs = deps.sliceMsFor?.(tool.name) ?? waitBudgetForTool(tool.name);
      const observed = await deps.registry.registerAndWait({
        toolCallId,
        toolName: tool.name,
        sliceMs,
        work: (signal) => {
          const nested: ToolCallContext = { abortSignal: signal };
          if (context?.emitStreamEvent) nested.emitStreamEvent = context.emitStreamEvent;
          return Promise.resolve(tool.call(args, nested));
        },
        ...(context?.abortSignal ? { parentSignal: context.abortSignal } : {}),
      });
      return finishObserve(observed, deps, toolCallId, tool.name);
    },
  };
  if (tool.requiresApproval !== undefined) wrapped.requiresApproval = tool.requiresApproval;
  if (tool.parseInput) wrapped.parseInput = (args) => tool.parseInput!(args);
  return wrapped;
}

export async function finishObserve(
  observed: ObserveResult,
  deps: Pick<WrapWaitBudgetDeps, "onProgress">,
  toolCallId: string,
  toolName: string,
): Promise<unknown> {
  if (observed.kind === "settled") {
    await emitProgress(deps, {
      toolCallId,
      toolName,
      phase: "completed",
      elapsedMs: 0,
      waitCount: 0,
    });
    return observed.output;
  }
  if (observed.kind === "still_running") {
    await emitProgress(deps, {
      toolCallId: observed.payload.toolCallId,
      toolName: observed.payload.toolName,
      phase: "wait_elapsed",
      elapsedMs: observed.payload.elapsedMs,
      waitCount: observed.payload.waitCount,
      ...(observed.payload.stage !== undefined ? { stage: observed.payload.stage } : {}),
    });
    return observed.payload;
  }
  if (observed.kind === "cancelled") {
    await emitProgress(deps, {
      toolCallId: observed.payload.toolCallId,
      toolName: observed.payload.toolName,
      phase: "cancelled",
      elapsedMs: observed.payload.elapsedMs,
      waitCount: 0,
      ...(observed.payload.stage !== undefined ? { stage: observed.payload.stage } : {}),
    });
    return observed.payload;
  }
  await emitProgress(deps, {
    toolCallId,
    toolName,
    phase: "failed",
    elapsedMs: 0,
    waitCount: 0,
  });
  throw observed.error;
}

async function emitProgress(
  deps: Pick<WrapWaitBudgetDeps, "onProgress">,
  event: ToolWaitProgress,
): Promise<void> {
  await deps.onProgress?.(event);
}
