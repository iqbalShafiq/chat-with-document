import { beforeEach, describe, expect, it, vi } from "vitest";

import { forkBodySchema, seedForkSession } from "./chat-fork.js";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    chatSession: { findFirst: vi.fn(), update: vi.fn() },
    agentMemorySession: { upsert: vi.fn() },
    agentMemoryMessage: { createMany: vi.fn() },
  },
}));

vi.mock("../../utils/prisma.js", () => ({ prisma: prismaMock }));

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function validBody() {
  return {
    sessionId: SESSION_ID,
    forkedFrom: { token: "tok-abc", title: "Shared chat" },
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ],
    firstMessage: "and then?",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("forkBodySchema", () => {
  it("accepts a bounded fork payload", () => {
    expect(forkBodySchema.safeParse(validBody()).success).toBe(true);
  });

  it("rejects oversized payloads", () => {
    const body = validBody();
    expect(
      forkBodySchema.safeParse({ ...body, firstMessage: "" }).success,
    ).toBe(false);
    expect(
      forkBodySchema.safeParse({
        ...body,
        messages: Array.from({ length: 41 }, () => ({
          role: "user",
          content: "x",
        })),
      }).success,
    ).toBe(false);
  });
});

describe("seedForkSession", () => {
  it("seeds an independent session with frozen provenance", async () => {
    prismaMock.chatSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      title: null,
    });
    prismaMock.chatSession.update.mockResolvedValue({});
    prismaMock.agentMemorySession.upsert.mockResolvedValue({ id: "mem-1" });
    prismaMock.agentMemoryMessage.createMany.mockResolvedValue({ count: 3 });

    const result = await seedForkSession({
      userId: USER_ID,
      body: validBody(),
    });

    expect(result).toEqual({ sessionId: SESSION_ID, seededMessages: 3 });
    expect(prismaMock.chatSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { title: "Fork of Shared chat" },
    });
    const created = prismaMock.agentMemoryMessage.createMany.mock.calls[0][0]
      .data as Array<{ role: string; position: number; turn: number }>;
    expect(created.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(created.map((row) => row.position)).toEqual([0, 1, 2]);
    const meta = prismaMock.agentMemorySession.upsert.mock.calls[0][0];
    expect(meta.create.metadata).toEqual({
      forkedFrom: { token: "tok-abc", title: "Shared chat" },
    });
  });

  it("rejects forks into sessions owned by someone else", async () => {
    prismaMock.chatSession.findFirst.mockResolvedValue(null);
    await expect(
      seedForkSession({ userId: USER_ID, body: validBody() }),
    ).rejects.toThrow("Fork target session not found");
    expect(prismaMock.agentMemoryMessage.createMany).not.toHaveBeenCalled();
  });
});
