import { normalizeToolResultOutput } from "@anvia/core/tool";
import { describe, expect, it, vi } from "vitest";
import { createRememberUserProfileTool } from "./profile-tool.js";

describe("createRememberUserProfileTool", () => {
  it("persists an explicit fact and returns strict JSON", async () => {
    const appendFact = vi.fn(async () => undefined);
    const tool = createRememberUserProfileTool({
      scope: { kind: "user", userId: "user-1" },
      source: { sessionId: "session-1", messageId: "message-1" },
      waitForActiveJob: vi.fn(async () => undefined),
      appendFact,
      refreshNow: vi.fn(async () => ({ processed: 1 })),
      reschedule: vi.fn(async () => undefined),
    });

    const output = await tool.call({ fact: "I prefer concise answers" });

    expect(appendFact).toHaveBeenCalledWith({
      section: null,
      fact: "I prefer concise answers",
      source: { sessionId: "session-1", messageId: "message-1" },
    });
    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: {
        ok: true,
        remembered: "I prefer concise answers",
        processed: 1,
      },
    });
  });

  it("returns a bounded JSON failure without failing the chat run", async () => {
    const tool = createRememberUserProfileTool({
      scope: { kind: "user", userId: "user-1" },
      source: { sessionId: "session-1", messageId: null },
      waitForActiveJob: vi.fn(async () => {
        throw new Error("profile worker unavailable");
      }),
      appendFact: vi.fn(async () => undefined),
      refreshNow: vi.fn(async () => ({ processed: 0 })),
      reschedule: vi.fn(async () => undefined),
    });

    const output = await tool.call({
      fact: "Remember my timezone",
      section: "preferences",
    });

    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: {
        ok: false,
        error: "Could not update profile right now: profile worker unavailable",
      },
    });
  });

  it("rejects a non-JSON mutation result through its output schema", async () => {
    const tool = createRememberUserProfileTool({
      scope: { kind: "user", userId: "user-1" },
      source: { sessionId: "session-1", messageId: null },
      waitForActiveJob: vi.fn(async () => undefined),
      appendFact: vi.fn(async () => undefined),
      refreshNow: vi.fn(async () => ({ processed: undefined as never })),
      reschedule: vi.fn(async () => undefined),
    });

    await expect(tool.call({ fact: "Remember this" })).rejects.toThrow();
  });

  it("does not start profile side effects after cancellation", async () => {
    const appendFact = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const tool = createRememberUserProfileTool({
      scope: { kind: "user", userId: "user-1" },
      source: { sessionId: "session-1", messageId: null },
      waitForActiveJob: vi.fn(async () => undefined),
      appendFact,
      refreshNow: vi.fn(async () => ({ processed: 0 })),
      reschedule: vi.fn(async () => undefined),
    });

    await expect(
      tool.call(
        { fact: "Remember this" },
        { abortSignal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(appendFact).not.toHaveBeenCalled();
  });
});
