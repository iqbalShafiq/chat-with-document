import { describe, expect, it } from "vitest";
import { InFlightToolRegistry, ToolCallUnknownError } from "./registry.js";

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

describe("InFlightToolRegistry", () => {
  it("returns the original output when work finishes inside the slice", async () => {
    const registry = new InFlightToolRegistry();
    const result = await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "read_dataset",
      sliceMs: 200,
      work: async () => ({ rows: 3 }),
    });
    expect(result).toEqual({ kind: "settled", output: { rows: 3 } });
    expect(registry.hasRunning()).toBe(false);
  });

  it("returns still_running without aborting work when the slice elapses", async () => {
    const registry = new InFlightToolRegistry();
    let finished = false;
    const first = await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "query_dataset_sql",
      sliceMs: 25,
      work: async (signal) => {
        await delay(80, signal);
        finished = true;
        return { ok: true };
      },
    });
    expect(first.kind).toBe("still_running");
    if (first.kind !== "still_running") throw new Error("expected still_running");
    expect(first.payload.toolCallId).toBe("a1");
    expect(first.payload.waitCount).toBe(1);
    expect(first.payload.mustInformUser).toBe(true);
    expect(first.payload.next).toEqual(["await_tool_call", "cancel_tool_call"]);
    expect(finished).toBe(false);
    expect(registry.hasRunning()).toBe(true);

    const second = await registry.awaitSlice("a1", 200);
    expect(second).toEqual({ kind: "settled", output: { ok: true } });
    expect(finished).toBe(true);
    expect(registry.hasRunning()).toBe(false);
  });

  it("does not start work again when awaiting a completed call", async () => {
    let calls = 0;
    const registry = new InFlightToolRegistry();
    await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "read_dataset",
      sliceMs: 200,
      work: async () => {
        calls += 1;
        return "once";
      },
    });
    const again = await registry.awaitSlice("a1", 200);
    expect(again).toEqual({ kind: "settled", output: "once" });
    expect(calls).toBe(1);
  });

  it("cancels the same call id and aborts work", async () => {
    const registry = new InFlightToolRegistry();
    let aborted = false;
    const first = await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "query_dataset_sql",
      sliceMs: 25,
      work: async (signal) => {
        try {
          await delay(500, signal);
          return "late";
        } catch (error) {
          aborted = true;
          throw error;
        }
      },
    });
    expect(first.kind).toBe("still_running");
    const cancelled = registry.cancel("a1");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.toolCallId).toBe("a1");
    const observed = await registry.awaitSlice("a1", 200);
    expect(observed.kind).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(registry.hasRunning()).toBe(false);
  });

  it("aborts child work when the parent signal aborts", async () => {
    const registry = new InFlightToolRegistry();
    const parent = new AbortController();
    const first = await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "web_fetch",
      parentSignal: parent.signal,
      sliceMs: 25,
      work: async (signal) => {
        await delay(500, signal);
        return "nope";
      },
    });
    expect(first.kind).toBe("still_running");
    parent.abort(new Error("run stopped"));
    const observed = await registry.awaitSlice("a1", 200);
    expect(observed.kind === "cancelled" || observed.kind === "failed").toBe(true);
  });

  it("fails unknown ids instead of starting a new call", async () => {
    const registry = new InFlightToolRegistry();
    await expect(registry.awaitSlice("missing", 10)).rejects.toBeInstanceOf(ToolCallUnknownError);
    expect(() => registry.cancel("missing")).toThrow(ToolCallUnknownError);
  });

  it("fails the job when the wall-clock budget is exceeded", async () => {
    const registry = new InFlightToolRegistry({ maxWallMs: 40 });
    const first = await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "query_dataset_sql",
      sliceMs: 20,
      work: async (signal) => {
        await delay(200, signal);
        return "late";
      },
    });
    expect(first.kind).toBe("still_running");
    await delay(25);
    const second = await registry.awaitSlice("a1", 20);
    expect(second.kind).toBe("failed");
    if (second.kind !== "failed") throw new Error("expected failed");
    expect(second.error).toBeInstanceOf(Error);
    expect((second.error as Error).name).toBe("TimeoutError");
  });

  it("tracks stage changes as progressMoved on the next observe", async () => {
    const registry = new InFlightToolRegistry();
    const first = await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "query_dataset_sql",
      sliceMs: 20,
      work: async (signal) => {
        await delay(80, signal);
        return "ok";
      },
    });
    expect(first.kind).toBe("still_running");
    if (first.kind !== "still_running") throw new Error("expected still_running");
    expect(first.payload.progressMoved).toBe(false);
    registry.setStage("a1", "uploading");
    const second = await registry.awaitSlice("a1", 20);
    expect(second.kind).toBe("still_running");
    if (second.kind !== "still_running") throw new Error("expected still_running");
    expect(second.payload.stage).toBe("uploading");
    expect(second.payload.progressMoved).toBe(true);
    expect(second.payload.waitCount).toBe(2);
  });

  it("abortAll cancels every running job", async () => {
    const registry = new InFlightToolRegistry();
    await registry.registerAndWait({
      toolCallId: "a1",
      toolName: "web_search",
      sliceMs: 20,
      work: async (signal) => delay(400, signal),
    });
    registry.abortAll("shutdown");
    expect(registry.hasRunning()).toBe(false);
    const observed = await registry.awaitSlice("a1", 50);
    expect(observed.kind).toBe("cancelled");
    expect(observed.kind === "cancelled" ? observed.payload.status : null).toBe("cancelled");
  });
});
