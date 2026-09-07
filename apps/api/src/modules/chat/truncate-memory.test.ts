import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  agentMemorySession: { findUnique: vi.fn(), update: vi.fn() },
  agentMemoryMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({
  prisma: db,
}));

import { Prisma } from "../../generated/prisma/client.js";
import {
  TruncateTargetNotFoundError,
  truncateSessionMemory,
} from "./truncate-memory.js";

const input = {
  sessionId: "session-1",
  userId: "user-1",
  mode: "include" as const,
};

function userMessage(clientMessageId = "prompt-1") {
  return {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    metadata: { clientMessageId },
  };
}

function nativeSummary() {
  return {
    role: "system",
    content: "Earlier conversation summary.",
    metadata: {
      anvia: {
        memoryCompaction: {
          version: 1,
          compactedMessageCount: 2,
        },
      },
    },
  };
}

describe("truncateSessionMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(
      async (work: (transaction: typeof db) => Promise<unknown>) => work(db),
    );
    db.agentMemorySession.findUnique.mockResolvedValue({ id: "memory-1" });
    db.agentMemoryMessage.findFirst.mockResolvedValue({
      id: "row-3",
      position: 3,
      message: userMessage(),
    });
    db.agentMemoryMessage.findMany.mockResolvedValue([]);
    db.agentMemoryMessage.count.mockResolvedValue(0);
    db.agentMemoryMessage.deleteMany.mockResolvedValue({ count: 2 });
    db.agentMemorySession.update.mockResolvedValue({});
  });

  it("fails closed when a stale position was removed by native compaction", async () => {
    db.agentMemoryMessage.findFirst.mockResolvedValueOnce(null);

    await expect(
      truncateSessionMemory({ ...input, memoryPosition: 1 }),
    ).rejects.toBeInstanceOf(TruncateTargetNotFoundError);
    expect(db.agentMemoryMessage.deleteMany).not.toHaveBeenCalled();
    expect(db.agentMemorySession.update).not.toHaveBeenCalled();
  });

  it("does not treat the native summary row at a stale position as a target", async () => {
    db.agentMemoryMessage.findFirst.mockResolvedValueOnce({
      id: "summary-row",
      position: 1,
      message: nativeSummary(),
    });

    await expect(
      truncateSessionMemory({ ...input, memoryPosition: 1 }),
    ).rejects.toBeInstanceOf(TruncateTargetNotFoundError);
    expect(db.agentMemoryMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only rows after the verified current target", async () => {
    await expect(
      truncateSessionMemory({ ...input, memoryPosition: 3 }),
    ).resolves.toMatchObject({
      ok: true,
      deleted: 2,
      keptThrough: 3,
      resolvedPosition: 3,
    });
    expect(db.agentMemoryMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        memorySessionId: "memory-1",
        position: { gt: 3 },
      },
    });
    expect(db.agentMemorySession.update).toHaveBeenCalledOnce();
    expect(db.agentMemorySession.update).toHaveBeenCalledWith({
      where: { id: "memory-1" },
      data: { updatedAt: expect.any(Date), compactionState: Prisma.DbNull },
    });
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
  });

  it("resolves a client id against the current row when no position is supplied", async () => {
    db.agentMemoryMessage.findMany.mockResolvedValueOnce([
      { id: "row-3", position: 3, message: userMessage("prompt-1") },
    ]);

    await expect(
      truncateSessionMemory({ ...input, clientMessageId: "prompt-1" }),
    ).resolves.toMatchObject({ resolvedPosition: 3 });
    expect(db.agentMemoryMessage.findFirst).not.toHaveBeenCalled();
  });

  it("allows a cancelled non-persisted prompt only when the native prefix count matches", async () => {
    db.agentMemoryMessage.findMany.mockResolvedValueOnce([]);
    db.agentMemoryMessage.count.mockResolvedValueOnce(2);

    await expect(
      truncateSessionMemory({
        ...input,
        mode: "exclude",
        clientMessageId: "cancelled-prompt",
        expectedPrefixMessageCount: 2,
      }),
    ).resolves.toEqual({
      ok: true,
      deleted: 0,
      keptThrough: -1,
      resolvedPosition: null,
    });
    expect(db.agentMemoryMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when a missing prompt's native prefix changed", async () => {
    db.agentMemoryMessage.findMany.mockResolvedValueOnce([]);
    db.agentMemoryMessage.count.mockResolvedValueOnce(3);

    await expect(
      truncateSessionMemory({
        ...input,
        mode: "exclude",
        clientMessageId: "cancelled-prompt",
        expectedPrefixMessageCount: 2,
      }),
    ).rejects.toBeInstanceOf(TruncateTargetNotFoundError);
    expect(db.agentMemoryMessage.deleteMany).not.toHaveBeenCalled();
  });
});
