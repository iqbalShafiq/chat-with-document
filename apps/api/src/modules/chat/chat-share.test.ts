import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChatShareNotFoundError,
  deactivateChatShares,
  generateShareToken,
  getLatestActiveChatShare,
  getPublicShareSnapshot,
} from "./chat-share.js";
import { createChatShare } from "./chat-share.js";

const { prismaMock, getChatSessionMock, loadMessagesMock } = vi.hoisted(
  () => ({
    prismaMock: {
      chatShare: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
        updateMany: vi.fn(),
      },
      user: { findUnique: vi.fn() },
    },
    getChatSessionMock: vi.fn(),
    loadMessagesMock: vi.fn(),
  }),
);

vi.mock("../../utils/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./chat-session.js", () => ({ getChatSession: getChatSessionMock }));
vi.mock("./enrich-memory-messages.js", () => ({
  loadEnrichedMemoryMessages: loadMessagesMock,
}));

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateShareToken", () => {
  it("mints unguessable URL-safe tokens distinct from session ids", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(21);
    expect(a).not.toBe(b);
    expect(a).not.toContain(SESSION_ID);
  });
});

describe("createChatShare", () => {
  it("snapshots current history under a fresh token", async () => {
    getChatSessionMock.mockResolvedValue({
      id: SESSION_ID,
      title: "Q3 notes",
    });
    loadMessagesMock.mockResolvedValue([{ role: "user" }]);
    prismaMock.chatShare.create.mockResolvedValue({
      id: "share-1",
      token: "tok-abc",
      sessionId: SESSION_ID,
      userId: USER_ID,
      title: "Q3 notes",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      revokedAt: null,
    });

    const share = await createChatShare({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(loadMessagesMock).toHaveBeenCalledWith(SESSION_ID, USER_ID);
    expect(prismaMock.chatShare.create).toHaveBeenCalledOnce();
    expect(share.token).toBe("tok-abc");
    expect(share.urlPath).toBe("/share/tok-abc");
  });
});

describe("getPublicShareSnapshot", () => {
  it("returns the frozen snapshot for an active token", async () => {
    prismaMock.chatShare.findUnique.mockResolvedValue({
      token: "tok-abc",
      revokedAt: null,
      title: "Q3 notes",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      session: { id: SESSION_ID, title: "Q3 notes" },
      userId: USER_ID,
    });
    prismaMock.user.findUnique.mockResolvedValue({ name: "Ana" });

    const snapshot = await getPublicShareSnapshot("tok-abc");

    expect(snapshot.title).toBe("Q3 notes");
    expect(snapshot.ownerName).toBe("Ana");
  });

  it("rejects revoked tokens and missing sessions", async () => {
    prismaMock.chatShare.findUnique.mockResolvedValueOnce({
      token: "tok-old",
      revokedAt: new Date(),
      session: { id: SESSION_ID, title: "x" },
      userId: USER_ID,
    });
    await expect(getPublicShareSnapshot("tok-old")).rejects.toBeInstanceOf(
      ChatShareNotFoundError,
    );

    prismaMock.chatShare.findUnique.mockResolvedValueOnce(null);
    await expect(getPublicShareSnapshot("nope")).rejects.toBeInstanceOf(
      ChatShareNotFoundError,
    );
  });
});

describe("getLatestActiveChatShare", () => {
  it("returns the newest active link first", async () => {
    prismaMock.chatShare.findFirst.mockResolvedValue({
      id: "share-2",
      token: "tok-new",
      sessionId: SESSION_ID,
      userId: USER_ID,
      title: "v2",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      revokedAt: null,
    });

    const latest = await getLatestActiveChatShare({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(latest?.token).toBe("tok-new");
    expect(prismaMock.chatShare.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, sessionId: SESSION_ID, revokedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("returns null when no active link exists", async () => {
    prismaMock.chatShare.findFirst.mockResolvedValue(null);

    await expect(
      getLatestActiveChatShare({ userId: USER_ID, sessionId: SESSION_ID }),
    ).resolves.toBeNull();
  });
});

describe("deactivateChatShares", () => {
  it("revokes every active link of the session at once", async () => {
    getChatSessionMock.mockResolvedValue({ id: SESSION_ID });
    prismaMock.chatShare.updateMany.mockResolvedValue({ count: 3 });

    const result = await deactivateChatShares({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(result).toEqual({ revoked: 3 });
    expect(prismaMock.chatShare.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, sessionId: SESSION_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
