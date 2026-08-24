import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  agentMemorySession: { findUnique: vi.fn() },
  agentMemoryMessage: { findMany: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({ prisma: db }));

import {
  FailedPromptCleanupError,
  removeFailedPromptForRetry,
} from "./remove-failed-prompt.js";

const input = {
  sessionId: "session-1",
  userId: "user-1",
  clientMessageId: "prompt-1",
};

describe("removeFailedPromptForRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (work: (tx: typeof db) => Promise<void>) => work(db));
    db.agentMemorySession.findUnique.mockResolvedValue({ id: "memory-1" });
    db.agentMemoryMessage.findMany.mockResolvedValue([{ id: "row-1" }]);
    db.agentMemoryMessage.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("finds one scoped user prompt and deletes only its row id", async () => {
    await removeFailedPromptForRetry(input);

    expect(db.agentMemoryMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        memorySessionId: "memory-1",
        AND: [
          { message: { path: ["metadata", "clientMessageId"], equals: "prompt-1" } },
          { message: { path: ["role"], equals: "user" } },
        ],
      },
      take: 2,
    }));
    expect(db.agentMemoryMessage.deleteMany).toHaveBeenCalledWith({
      where: { id: "row-1", memorySessionId: "memory-1" },
    });
  });

  it.each([
    ["missing", []],
    ["ambiguous", [{ id: "row-1" }, { id: "row-2" }]],
  ])("fails closed when the prompt identity is %s", async (_name, rows) => {
    db.agentMemoryMessage.findMany.mockResolvedValueOnce(rows);
    await expect(removeFailedPromptForRetry(input)).rejects.toBeInstanceOf(FailedPromptCleanupError);
    expect(db.agentMemoryMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when the exact row loses the delete race", async () => {
    db.agentMemoryMessage.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(removeFailedPromptForRetry(input)).rejects.toBeInstanceOf(FailedPromptCleanupError);
  });
});
