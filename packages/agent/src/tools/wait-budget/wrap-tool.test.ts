import { describe, expect, it, vi } from "vitest";
import type { AnyTool, ToolCallContext } from "@anvia/core";
import { createQuestionTool, isQuestionTool } from "@anvia/core/tool";
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

  it("preserves the question-tool marker so the agent runtime still suspends", () => {
    const registry = new InFlightToolRegistry();
    const question = createQuestionTool({
      name: "request_clarification",
      description: "Ask the user before acting.",
    });
    expect(isQuestionTool(question)).toBe(true);
    const [wrapped] = wrapToolsWithWaitBudget([question as unknown as AnyTool], {
      registry,
      sliceMsFor: () => 200,
    });
    expect(isQuestionTool(wrapped)).toBe(true);
  });

  it("registers the unique internalCallId, not the reused provider toolCallId", async () => {
    const registry = new InFlightToolRegistry();
    const ids = createToolCallIdGate();
    ids.note("read_dataset", "tool_0", "internal-1");
    const [wrapped] = wrapToolsWithWaitBudget(
      [fakeTool("read_dataset", async () => "ok")],
      { registry, ids, sliceMsFor: () => 200, nextId: () => "generated" },
    );
    await wrapped!.call({});
    expect(registry.peek("internal-1")?.status).toBe("completed");
    expect(registry.peek("tool_0")).toBeUndefined();
    expect(registry.peek("generated")).toBeUndefined();
  });

  it("lets a second tool run while the first is still waiting, even if both got tool_0", async () => {
    const registry = new InFlightToolRegistry();
    const ids = createToolCallIdGate();
    ids.note("web_search", "tool_0", "internal-search");
    ids.note("generate_image", "tool_0", "internal-image");
    const search = vi.fn(async (_args: unknown, context?: ToolCallContext) => {
      await delay(80, context?.abortSignal);
      return { query: "school" };
    });
    const image = vi.fn(async () => ({ images: ["ok"] }));
    const [searchTool, imageTool] = wrapToolsWithWaitBudget(
      [fakeTool("web_search", search), fakeTool("generate_image", image)],
      { registry, ids, sliceMsFor: () => 25 },
    );

    const checkpoint = await searchTool!.call({});
    expect(isStillRunningResult(checkpoint)).toBe(true);
    if (!isStillRunningResult(checkpoint)) throw new Error("expected still_running");
    expect(checkpoint.toolCallId).toBe("internal-search");

    const imageOutput = await imageTool!.call({});
    expect(imageOutput).toEqual({ images: ["ok"] });
    expect(image).toHaveBeenCalledOnce();
    expect(registry.peek("internal-search")?.status).toBe("running");
    expect(registry.peek("internal-image")?.status).toBe("completed");

    const [awaitTool] = createAwaitCancelTools({ registry, sliceMsFor: () => 200 });
    await expect(awaitTool!.call({ toolCallId: checkpoint.toolCallId })).resolves.toEqual({
      query: "school",
    });
  });

  it("mirrors wait progress onto the provider id so the original card still updates", async () => {
    const registry = new InFlightToolRegistry();
    const ids = createToolCallIdGate();
    ids.note("web_search", "tool_0", "internal-search");
    const progress: Array<{ toolCallId: string; phase: string }> = [];
    const [wrapped] = wrapToolsWithWaitBudget(
      [fakeTool("web_search", async () => ({ ok: true }))],
      {
        registry,
        ids,
        sliceMsFor: () => 200,
        onProgress: (event) => {
          progress.push({ toolCallId: event.toolCallId, phase: event.phase });
        },
      },
    );
    await wrapped!.call({});
    expect(progress).toEqual([
      { toolCallId: "internal-search", phase: "running" },
      { toolCallId: "tool_0", phase: "running" },
      { toolCallId: "internal-search", phase: "completed" },
      { toolCallId: "tool_0", phase: "completed" },
    ]);
  });
});
