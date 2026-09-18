import { describe, expect, it, vi } from "vitest";
import type { AnyTool, ToolCallContext } from "@anvia/core";
import { isStillRunningResult } from "./types.js";
import { createSubAgentWaitBudget } from "./sub-agent.js";
import { SUB_AGENT_TOOL_WAIT_INSTRUCTION } from "../../prompts/tool-wait-instructions.js";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      },
      { once: true },
    );
  });
}

function fakeTool(
  name: string,
  impl: (args: unknown, context?: ToolCallContext) => Promise<unknown>,
): AnyTool {
  return {
    name,
    definition: () => ({ name, description: name, parameters: { type: "object", properties: {} } }),
    call: impl,
  };
}

describe("createSubAgentWaitBudget", () => {
  it("turns a slow nested tool into a checkpoint instead of blocking", async () => {
    const budget = createSubAgentWaitBudget({ sliceMsFor: () => 20 });
    const inner = vi.fn(async (_args: unknown, context?: ToolCallContext) => {
      await delay(300, context?.abortSignal);
      return { rows: [1] };
    });
    const [wrapped] = budget.wrapTools([fakeTool("web_fetch", inner)]);

    const first = await wrapped!.call({});
    expect(isStillRunningResult(first)).toBe(true);

    // The agent keeps waiting on the same call through the control tool until
    // the work settles, exactly like the parent agent does.
    const [awaitTool] = budget.controlTools();
    const toolCallId = (first as { toolCallId: string }).toolCallId;
    let observed: unknown = first;
    for (let attempt = 0; attempt < 20 && isStillRunningResult(observed); attempt += 1) {
      observed = await awaitTool!.call({ toolCallId });
    }

    expect(observed).toEqual({ rows: [1] });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("leaves the control tools themselves unwrapped", () => {
    const budget = createSubAgentWaitBudget({ sliceMsFor: () => 1 });
    const controls = budget.controlTools();
    const wrapped = budget.wrapTools(controls);
    expect(wrapped[0]).toBe(controls[0]);
    expect(wrapped[1]).toBe(controls[1]);
  });

  it("uses the unique internalCallId recorded by its middleware", async () => {
    const budget = createSubAgentWaitBudget({ sliceMsFor: () => 200 });
    const middleware = budget.middleware();
    await middleware.onToolInput?.({
      toolName: "web_search",
      args: "{}",
      originalArgs: "{}",
      turn: 1,
      toolCallId: "tool_0",
      internalCallId: "internal-1",
    });

    const [wrapped] = budget.wrapTools([fakeTool("web_search", async () => "ok")]);
    await wrapped!.call({});

    expect(budget.registry.peek("internal-1")?.status).toBe("completed");
    expect(budget.registry.peek("tool_0")).toBeUndefined();
  });

  it("aborts outstanding nested jobs so nothing keeps running after the run ends", async () => {
    const budget = createSubAgentWaitBudget({ sliceMsFor: () => 20 });
    let aborted = false;
    const [wrapped] = budget.wrapTools([
      fakeTool("web_search", async (_args, context?: ToolCallContext) => {
        try {
          await delay(5_000, context?.abortSignal);
          return "late";
        } catch (error) {
          aborted = true;
          throw error;
        }
      }),
    ]);

    const first = await wrapped!.call({});
    expect(isStillRunningResult(first)).toBe(true);
    expect(budget.registry.hasRunning()).toBe(true);

    budget.abortOutstanding("research finished");
    expect(budget.registry.hasRunning()).toBe(false);
    await delay(10);
    expect(aborted).toBe(true);
  });

  it("keeps sub-agent narration out of the user-facing report", () => {
    const budget = createSubAgentWaitBudget();
    expect(budget.instructions).toBe(SUB_AGENT_TOOL_WAIT_INSTRUCTION);
    expect(budget.instructions).toMatch(/never cancel it merely because it is slow/i);
    expect(budget.instructions).toMatch(/do not write user-facing prose/i);
    expect(budget.instructions).toMatch(/never invent results/i);
  });
});