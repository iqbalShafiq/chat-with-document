import { randomUUID } from "node:crypto";
import type { AnyTool, ToolCallContext } from "@anvia/core";
import { waitBudgetForTool } from "./limits.js";
import { InFlightToolRegistry } from "./registry.js";
import type { ObserveResult } from "./types.js";
import { isControlToolName, type ToolWaitProgress } from "./types.js";

export type NotedToolCallIds = {
  /** Unique wait-registry / await_tool_call id. Never the reused provider id. */
  jobId: string;
  /** Provider-facing id (often "tool_0"). Used only so the original card can show wait progress. */
  providerToolCallId?: string;
};

export type ToolCallIdGate = {
  note(
    toolName: string,
    providerToolCallId?: string,
    internalCallId?: string,
  ): void;
  take(toolName: string): NotedToolCallIds | undefined;
};

export function createToolCallIdGate(): ToolCallIdGate {
  const queues = new Map<string, NotedToolCallIds[]>();
  return {
    note(toolName, providerToolCallId, internalCallId) {
      const jobId = internalCallId?.trim() || randomUUID();
      const noted: NotedToolCallIds = { jobId };
      const provider = providerToolCallId?.trim();
      if (provider) noted.providerToolCallId = provider;
      const queue = queues.get(toolName) ?? [];
      queue.push(noted);
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
      const taken = deps.ids?.take(tool.name);
      const jobId = taken?.jobId ?? deps.nextId?.() ?? randomUUID();
      const providerToolCallId = taken?.providerToolCallId;
      await emitCallProgress(deps, {
        jobId,
        providerToolCallId,
        toolName: tool.name,
        phase: "running",
        elapsedMs: 0,
        waitCount: 0,
      });
      const sliceMs = deps.sliceMsFor?.(tool.name) ?? waitBudgetForTool(tool.name);
      const observed = await deps.registry.registerAndWait({
        toolCallId: jobId,
        toolName: tool.name,
        sliceMs,
        work: (signal) => {
          const nested: ToolCallContext = { abortSignal: signal };
          if (context?.emitStreamEvent) nested.emitStreamEvent = context.emitStreamEvent;
          return Promise.resolve(tool.call(args, nested));
        },
        ...(context?.abortSignal ? { parentSignal: context.abortSignal } : {}),
      });
      return finishObserve(observed, deps, jobId, tool.name, providerToolCallId);
    },
    ...(tool.requiresApproval !== undefined ? { requiresApproval: tool.requiresApproval } : {}),
    ...(tool.parseInput ? { parseInput: (args: Parameters<NonNullable<AnyTool["parseInput"]>>[0]) => tool.parseInput!(args) } : {}),
  };
  return wrapped;
}

export async function finishObserve(
  observed: ObserveResult,
  deps: Pick<WrapWaitBudgetDeps, "onProgress">,
  toolCallId: string,
  toolName: string,
  providerToolCallId?: string,
): Promise<unknown> {
  if (observed.kind === "settled") {
    await emitCallProgress(deps, {
      jobId: toolCallId,
      providerToolCallId,
      toolName,
      phase: "completed",
      elapsedMs: 0,
      waitCount: 0,
    });
    return observed.output;
  }
  if (observed.kind === "still_running") {
    await emitCallProgress(deps, {
      jobId: observed.payload.toolCallId,
      providerToolCallId,
      toolName: observed.payload.toolName,
      phase: "wait_elapsed",
      elapsedMs: observed.payload.elapsedMs,
      waitCount: observed.payload.waitCount,
      ...(observed.payload.stage !== undefined ? { stage: observed.payload.stage } : {}),
    });
    return observed.payload;
  }
  if (observed.kind === "cancelled") {
    await emitCallProgress(deps, {
      jobId: observed.payload.toolCallId,
      providerToolCallId,
      toolName: observed.payload.toolName,
      phase: "cancelled",
      elapsedMs: observed.payload.elapsedMs,
      waitCount: 0,
      ...(observed.payload.stage !== undefined ? { stage: observed.payload.stage } : {}),
    });
    return observed.payload;
  }
  await emitCallProgress(deps, {
    jobId: toolCallId,
    providerToolCallId,
    toolName,
    phase: "failed",
    elapsedMs: 0,
    waitCount: 0,
  });
  throw observed.error;
}

async function emitCallProgress(
  deps: Pick<WrapWaitBudgetDeps, "onProgress">,
  event: {
    jobId: string;
    providerToolCallId?: string;
    toolName: string;
    phase: ToolWaitProgress["phase"];
    elapsedMs: number;
    waitCount: number;
    stage?: string;
  },
): Promise<void> {
  if (!deps.onProgress) return;
  const payload: ToolWaitProgress = {
    toolCallId: event.jobId,
    toolName: event.toolName,
    phase: event.phase,
    elapsedMs: event.elapsedMs,
    waitCount: event.waitCount,
    ...(event.stage !== undefined ? { stage: event.stage } : {}),
  };
  await deps.onProgress(payload);
  // The original card is keyed by the provider id (often reused "tool_0").
  // Mirror progress there so elapsed wait still lands on that card.
  if (event.providerToolCallId && event.providerToolCallId !== event.jobId) {
    await deps.onProgress({ ...payload, toolCallId: event.providerToolCallId });
  }
}
