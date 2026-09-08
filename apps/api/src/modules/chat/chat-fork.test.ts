import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatShareNotFoundError } from "./chat-share.js";
import { forkBodySchema, seedForkSession } from "./chat-fork.js";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    chatSession: { create: vi.fn() },
    chatShare: { findUnique: vi.fn() },
    agentMemorySession: { upsert: vi.fn() },
    agentMemoryMessage: { createMany: vi.fn() },
  },
}));

vi.mock("../../utils/prisma.js", () => ({ prisma: prismaMock }));

const USER_ID = "user-1";
const TOKEN = "tok-abc";

function snapshotMessage(role: "user" | "assistant", text: string) {
  return {
    role,
    content: [{ type: "text", text }],
    metadata: { createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

function shareRow() {
  return {
    token: TOKEN,
    revokedAt: null,
    title: "Shared chat",
    session: { id: "source-session", title: "Shared chat" },
    snapshot: [
      snapshotMessage("user", "hello"),
      snapshotMessage("assistant", "hi there"),
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("forkBodySchema", () => {
  it("accepts a token-only fork payload", () => {
    expect(forkBodySchema.safeParse({ token: TOKEN }).success).toBe(true);
  });

  it("rejects empty tokens and unknown fields", () => {
    expect(forkBodySchema.safeParse({ token: "  " }).success).toBe(false);
    expect(
      forkBodySchema.safeParse({ token: TOKEN, firstMessage: "x" }).success,
    ).toBe(false);
  });
});

describe("seedForkSession", () => {
  it("seeds the frozen snapshot into a new viewer-owned session", async () => {
    prismaMock.chatShare.findUnique.mockResolvedValue(shareRow());
    prismaMock.chatSession.create.mockImplementation(
      async (args: { data: { id: string } }) => args.data,
    );
    prismaMock.agentMemorySession.upsert.mockResolvedValue({ id: "mem-1" });
    prismaMock.agentMemoryMessage.createMany.mockResolvedValue({ count: 2 });

    const result = await seedForkSession({ userId: USER_ID, token: TOKEN });

    expect(prismaMock.chatShare.findUnique).toHaveBeenCalledWith({
      where: { token: TOKEN },
      include: { session: { select: { id: true, title: true } } },
    });
    expect(prismaMock.chatSession.create).toHaveBeenCalledOnce();
    expect(result.seededMessages).toBe(2);
    expect(typeof result.sessionId).toBe("string");
    const created = prismaMock.chatSession.create.mock.calls[0][0].data as {
      userId: string;
      projectId: null;
      title: string;
    };
    expect(created.userId).toBe(USER_ID);
    expect(created.projectId).toBeNull();
    expect(created.title).toBe("Fork of Shared chat");
    const rows = prismaMock.agentMemoryMessage.createMany.mock.calls[0][0]
      .data as Array<{ role: string; position: number; turn: number }>;
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    const meta = prismaMock.agentMemorySession.upsert.mock.calls[0][0];
    expect(meta.create.metadata).toEqual({
      forkedFrom: { token: TOKEN, title: "Shared chat" },
    });
  });

  it("rejects revoked tokens and missing snapshots", async () => {
    prismaMock.chatShare.findUnique.mockResolvedValue({
      ...shareRow(),
      revokedAt: new Date(),
    });
    await expect(seedForkSession({ userId: USER_ID, token: TOKEN })).rejects.toBeInstanceOf(
      ChatShareNotFoundError,
    );
    expect(prismaMock.agentMemoryMessage.createMany).not.toHaveBeenCalled();

    prismaMock.chatShare.findUnique.mockResolvedValue(null);
    await expect(seedForkSession({ userId: USER_ID, token: TOKEN })).rejects.toBeInstanceOf(
      ChatShareNotFoundError,
    );
  });
});
