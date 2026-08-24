import {
  estimateMemoryTokens,
  isMemoryCompactionMessage,
  type CompletionModel,
  type MemoryStore,
  type Message,
} from "@anvia/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./agent.js";

const model = {
  provider: "test",
  modelId: "test/model",
  completion: async () => {
    throw new Error("not called");
  },
} as unknown as CompletionModel;

const memory: MemoryStore = {
  load: async () => [],
  append: async () => undefined,
  clear: async () => undefined,
  compaction: {
    snapshot: async () => ({ revision: "r1", messages: [] }),
    replacePrefix: async () => ({ status: "conflict" }),
  },
};

describe("createAgent native memory configuration", () => {
  it("forwards the v1 token-aware compaction policy without app-owned semantics", () => {
    const compactor = async () => ({ summary: "summary" });
    const agent = createAgent({
      agentId: "chat-agent",
      model,
      memory: {
        store: memory,
        savePolicy: "turn",
        compaction: {
          trigger: { afterTokens: 100 },
          retention: { recentTokens: 40 },
          compactor,
          conflictRetries: { maxAttempts: 3 },
        },
      },
    });

    expect(agent.memory).toMatchObject({
      store: memory,
      savePolicy: "turn",
      compaction: {
        trigger: { afterTokens: 100 },
        retention: { recentTokens: 40 },
        compactor,
        conflictRetries: { maxAttempts: 3 },
      },
    });
  });

  it("uses the official counter and native marker shape for compaction fixtures", () => {
    const summary = {
      role: "system",
      content: "earlier",
      metadata: {
        anvia: { memoryCompaction: { version: 1, compactedMessageCount: 2 } },
      },
    } as Message;
    expect(isMemoryCompactionMessage(summary)).toBe(true);
    expect(summary.metadata).toEqual({
      anvia: { memoryCompaction: { version: 1, compactedMessageCount: 2 } },
    });
    expect(estimateMemoryTokens([summary])).toBeGreaterThan(0);
  });
});
