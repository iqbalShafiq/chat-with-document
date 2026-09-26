import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAgentUsageEvent: vi.fn(async () => undefined),
}));

vi.mock("./record-usage.js", () => ({
  recordAgentUsageEvent: mocks.recordAgentUsageEvent,
}));

import { tapAgentStreamUsage } from "./tap-agent-usage.js";

const ctx = {
  userId: "u1",
  sessionId: "s1",
  provider: "openai",
  model: "openai/gpt-6-luna",
  reasoningEffort: "high",
  agentId: "chat-agent",
};

async function* source(events: unknown[]) {
  for (const event of events) yield event;
}

async function drain(events: unknown[]) {
  const seen: unknown[] = [];
  for await (const item of tapAgentStreamUsage(source(events), ctx)) {
    seen.push(item);
  }
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tapAgentStreamUsage", () => {
  it("records a completed usage event on final with usage and passes items through", async () => {
    const final = {
      type: "final",
      runId: "run-9",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    const seen = await drain([{ type: "text_delta" }, final]);
    expect(seen).toHaveLength(2);
    expect(mocks.recordAgentUsageEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        sessionId: "s1",
        runId: "run-9",
        provider: "openai",
        model: "openai/gpt-6-luna",
        status: "completed",
        usage: expect.objectContaining({ inputTokens: 10, cachedInputTokens: 0 }),
      }),
    );
  });

  it("skips finals without usage and never records twice", async () => {
    await drain([{ type: "final" }]);
    expect(mocks.recordAgentUsageEvent).not.toHaveBeenCalled();

    await drain([
      { type: "error", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "final", usage: { inputTokens: 2, outputTokens: 2 } },
    ]);
    expect(mocks.recordAgentUsageEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
    );
  });
});
