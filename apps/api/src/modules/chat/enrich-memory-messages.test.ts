import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@anvia/core";

const db = vi.hoisted(() => ({
  agentMemorySession: {
    findUnique: vi.fn(),
  },
  agentMemoryMessage: {
    findMany: vi.fn(),
  },
}));
const compaction = vi.hoisted(() => ({
  loadCompactionSegments: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({ prisma: db }));
vi.mock("./compaction.js", () => compaction);
vi.mock("@assingment/agent", () => ({
  extractTextFromMessageJson: (message: { content?: unknown }) => {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
  },
  parseCitationsFromText: () => ({
    citations: [{ id: 1, filename: "brief.pdf", pageIndex: 2 }],
  }),
  citationsToJsonValue: (citations: unknown) => citations,
}));

import { loadEnrichedMemoryMessages } from "./enrich-memory-messages.js";

describe("loadEnrichedMemoryMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.agentMemorySession.findUnique.mockResolvedValue({ id: "memory-1" });
    compaction.loadCompactionSegments.mockResolvedValue([]);
  });

  it("enriches strict v1 assistant messages with row metadata and citations", async () => {
    const assistant = {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "See [[cite:1]].\n```citations\n[{\"id\":1,\"filename\":\"brief.pdf\",\"pageIndex\":2}]\n```",
        },
      ],
      metadata: { clientMessageId: "client-1", custom: "kept" },
    } as Message;
    const createdAt = new Date("2026-08-24T00:00:00.000Z");
    db.agentMemoryMessage.findMany.mockResolvedValue([
      {
        position: 7,
        createdAt,
        message: assistant,
        role: "assistant",
      },
    ]);

    const result = await loadEnrichedMemoryMessages("session-1", "user-1");

    expect(result).toEqual([
      {
        ...assistant,
        metadata: {
          clientMessageId: "client-1",
          custom: "kept",
          createdAt: createdAt.toISOString(),
          memoryPosition: 7,
          citations: [{ id: 1, filename: "brief.pdf", pageIndex: 2 }],
        },
      },
    ]);
    expect(db.agentMemorySession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scopeKey: JSON.stringify(["session-1", "user-1"]) },
      }),
    );
  });

  it("leaves strict v1 tool messages metadata-free for UI tool-result merging", async () => {
    const tool = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "search_docs",
          output: { type: "text", value: "result" },
        },
      ],
    } as Message;
    db.agentMemoryMessage.findMany.mockResolvedValue([
      {
        position: 1,
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
        message: tool,
        role: "tool",
      },
    ]);

    const result = await loadEnrichedMemoryMessages("session-1", "user-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(tool);
    expect(result[0]).not.toHaveProperty("metadata");
  });

  it("inserts a summary divider after the covered strict-message row", async () => {
    const user = { role: "user", content: "first" } as Message;
    const assistant = { role: "assistant", content: "latest" } as Message;
    db.agentMemoryMessage.findMany.mockResolvedValue([
      {
        position: 1,
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
        message: user,
        role: "user",
      },
      {
        position: 2,
        createdAt: new Date("2026-08-24T00:01:00.000Z"),
        message: assistant,
        role: "assistant",
      },
    ]);
    compaction.loadCompactionSegments.mockResolvedValue([
      {
        kind: "summarized",
        upToPosition: 1,
        summary: "Earlier context",
        createdAt: "2026-08-24T00:02:00.000Z",
      },
    ]);

    const result = await loadEnrichedMemoryMessages("session-1", "user-1");

    expect(result).toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
      {
        role: "system",
        content: "Earlier context",
        metadata: { kind: "summary" },
      },
      expect.objectContaining({ role: "assistant", content: "latest" }),
    ]);
  });

  it("rejects legacy persisted rows instead of exposing them to UI conversion", async () => {
    db.agentMemoryMessage.findMany.mockResolvedValue([
      {
        position: 1,
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
        role: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call-1",
              function: { name: "search_docs", arguments: "{}" },
            },
          ],
        },
      },
    ]);

    await expect(
      loadEnrichedMemoryMessages("session-1", "user-1"),
    ).rejects.toThrow();
  });
});
