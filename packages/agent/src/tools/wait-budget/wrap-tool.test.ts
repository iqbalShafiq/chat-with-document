import { describe, expect, it, vi } from "vitest";
import type { AnyTool, ToolCallContext } from "@anvia/core";
import { InFlightToolRegistry } from "./registry.js";
import { isStillRunningResult } from "./types.js";
import { createAwaitCancelTools } from "./await-cancel-tools.js";
import { createToolCallIdGate, wrapToolsWithWaitBudget } from "./wrap-tool.js";

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

describe("wrapToolsWithWaitBudget", () => {
  it("returns the original output for a fast tool", async () => {
    const registry = new InFlightToolRegistry();
    const inner = vi.fn(async () => ({ ok: true }));
    const [wrapped] = wrapToolsWithWaitBudget([fakeTool("read_dataset", inner)], {
      registry,
      sliceMsFor: () => 200,
      nextId: () => "call-1",
    });
    const output = await wrapped!.call({});
    expect(output).toEqual({ ok: true });
    expect(inner).toHaveBeenCalledOnce();
    expect(isStillRunningResult(output)).toBe(false);
  });

  it("returns still_running and keeps the original work alive", async () => {
    const registry = new InFlightToolRegistry();
    const inner = vi.fn(async (_args: unknown, context?: ToolCallContext) => {
      await delay(80, context?.abortSignal);
      return { rows: [1] };
    });
    const [wrapped] = wrapToolsWithWaitBudget([fakeTool("query_dataset_sql", inner)], {
      registry,
      sliceMsFor: () => 25,
      nextId: () => "call-1",
    });
    const output = await wrapped!.call({});
    expect(isStillRunningResult(output)).toBe(true);
    if (!isStillRunningResult(output)) throw new Error("expected still_running");
    expect(output.toolCallId).toBe("call-1");
    expect(inner).toHaveBeenCalledOnce();

    const [awaitTool] = createAwaitCancelTools({ registry, sliceMsFor: () => 200 });
    const settled = await awaitTool!.call({ toolCallId: "call-1" });
    expect(settled).toEqual({ rows: [1] });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("cancels the same call without invoking the original tool again", async () => {
    const registry = new InFlightToolRegistry();
    const inner = vi.fn(async (_args: unknown, context?: ToolCallContext) => {
      await delay(400, context?.abortSignal);
      return "late";
    });
    const [wrapped] = wrapToolsWithWaitBudget([fakeTool("query_dataset_sql", inner)], {
      registry,
      sliceMsFor: () => 25,
      nextId: () => "call-1",
    });
    await wrapped!.call({});
    const tools = createAwaitCancelTools({ registry, sliceMsFor: () => 25 });
    const cancelTool = tools[1]!;
    const cancelled = await cancelTool.call({ toolCallId: "call-1" });
    expect(cancelled).toMatchObject({ status: "cancelled", toolCallId: "call-1" });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("does not wrap await/cancel control tools", () => {
    const registry = new InFlightToolRegistry();
    const controls = createAwaitCancelTools({ registry });
    const wrapped = wrapToolsWithWaitBudget(controls, { registry, sliceMsFor: () => 1 });
    expect(wrapped[0]).toBe(controls[0]);
    expect(wrapped[1]).toBe(controls[1]);
  });

  it("prefers the Anvia toolCallId from the id gate", async () => {
    const registry = new InFlightToolRegistry();
    const ids = createToolCallIdGate();
    ids.note("read_dataset", "anvia-id");
    const [wrapped] = wrapToolsWithWaitBudget(
      [fakeTool("read_dataset", async () => "ok")],
      { registry, ids, sliceMsFor: () => 200, nextId: () => "generated" },
    );
    await wrapped!.call({});
    expect(registry.peek("anvia-id")?.status).toBe("completed");
    expect(registry.peek("generated")).toBeUndefined();
  });
});
