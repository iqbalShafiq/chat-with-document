import { describe, expect, it, vi } from "vitest";
import {
  createContextSnippetStore,
  formatContextSnippetBlock,
  parseContextSnippetBody,
  type ContextSnippetRecord,
  type ContextSnippetStorePrisma,
} from "./context-snippets.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";

function makeRecord(
  overrides: Partial<ContextSnippetRecord> = {},
): ContextSnippetRecord {
  return {
    id: "snippet-1",
    userId: USER_ID,
    sessionId: SESSION_ID,
    text: "The quick brown fox jumps over the lazy dog.",
    sourceRole: "assistant",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function setup() {
  const fakePrisma = {
    chatSession: { findFirst: vi.fn() },
    sessionContextSnippet: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const store = createContextSnippetStore({
    prisma: fakePrisma as unknown as ContextSnippetStorePrisma,
  });
  return { fakePrisma, store };
}

describe("createContextSnippetStore", () => {
  describe("getSessionContextSnippet", () => {
    it("returns null for a session the user does not own", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.chatSession.findFirst.mockResolvedValue(null);

      const snippet = await store.getSessionContextSnippet({
        userId: USER_ID,
        sessionId: SESSION_ID,
      });

      expect(snippet).toBeNull();
      expect(fakePrisma.sessionContextSnippet.findUnique).not.toHaveBeenCalled();
    });

    it("returns the row for an owned session", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.chatSession.findFirst.mockResolvedValue({ id: SESSION_ID });
      fakePrisma.sessionContextSnippet.findUnique.mockResolvedValue(
        makeRecord(),
      );

      const snippet = await store.getSessionContextSnippet({
        userId: USER_ID,
        sessionId: SESSION_ID,
      });

      expect(snippet?.text).toBe("The quick brown fox jumps over the lazy dog.");
      expect(fakePrisma.sessionContextSnippet.findUnique).toHaveBeenCalledWith({
        where: { sessionId: SESSION_ID },
      });
    });
  });

  describe("upsertContextSnippet", () => {
    it("replaces the previous snippet (upsert by sessionId)", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.chatSession.findFirst.mockResolvedValue({ id: SESSION_ID });
      fakePrisma.sessionContextSnippet.upsert.mockImplementation(
        async ({ create }: { create: Record<string, unknown> }) => ({
          id: "snippet-1",
          ...create,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );

      const snippet = await store.upsertContextSnippet({
        userId: USER_ID,
        sessionId: SESSION_ID,
        text: "Replacement text",
        sourceRole: "user",
      });

      expect(fakePrisma.sessionContextSnippet.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionId: SESSION_ID },
          create: expect.objectContaining({
            userId: USER_ID,
            sessionId: SESSION_ID,
            text: "Replacement text",
            sourceRole: "user",
          }),
        }),
      );
      expect(snippet.text).toBe("Replacement text");
    });

    it("throws when the session is not owned by the user", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(
        store.upsertContextSnippet({
          userId: USER_ID,
          sessionId: "foreign-session",
          text: "x",
          sourceRole: "user",
        }),
      ).rejects.toThrow("session not found");
      expect(fakePrisma.sessionContextSnippet.upsert).not.toHaveBeenCalled();
    });
  });

  describe("removeContextSnippet", () => {
    it("deletes scoped by user and id, returning whether anything matched", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.sessionContextSnippet.deleteMany.mockResolvedValue({
        count: 1,
      });

      const removed = await store.removeContextSnippet({
        userId: USER_ID,
        snippetId: "snippet-1",
      });

      expect(removed).toBe(true);
      expect(fakePrisma.sessionContextSnippet.deleteMany).toHaveBeenCalledWith({
        where: { id: "snippet-1", userId: USER_ID },
      });
    });
  });

  describe("clearSessionContextSnippet", () => {
    it("deletes the row for the user + session", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.sessionContextSnippet.deleteMany.mockResolvedValue({
        count: 1,
      });

      await store.clearSessionContextSnippet({ userId: USER_ID, sessionId: SESSION_ID });

      expect(fakePrisma.sessionContextSnippet.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, sessionId: SESSION_ID },
      });
    });
  });
});

describe("parseContextSnippetBody", () => {
  it("accepts valid text + sourceRole", () => {
    expect(
      parseContextSnippetBody({ text: " hello ", sourceRole: "user" }),
    ).toEqual({ text: " hello ", sourceRole: "user" });
  });

  it("rejects missing text", () => {
    expect(parseContextSnippetBody({ sourceRole: "user" })).toBeNull();
  });

  it("rejects blank text", () => {
    expect(parseContextSnippetBody({ text: "   ", sourceRole: "user" })).toBeNull();
  });

  it("rejects text over 2000 chars", () => {
    expect(
      parseContextSnippetBody({ text: "x".repeat(2001), sourceRole: "user" }),
    ).toBeNull();
  });

  it("rejects unknown sourceRole", () => {
    expect(
      parseContextSnippetBody({ text: "x", sourceRole: "system" }),
    ).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(parseContextSnippetBody(null)).toBeNull();
    expect(parseContextSnippetBody("text")).toBeNull();
  });
});

describe("formatContextSnippetBlock", () => {
  it("labels the source role and quotes the text", () => {
    const block = formatContextSnippetBlock({
      text: "Rome was not built in a day.",
      sourceRole: "assistant",
    });
    expect(block).toContain("from the assistant");
    expect(block).toContain("Rome was not built in a day.");
  });

  it("labels user selections as from the user", () => {
    const block = formatContextSnippetBlock({
      text: "My budget is $5k.",
      sourceRole: "user",
    });
    expect(block).toContain("from the user");
    expect(block).toContain("My budget is $5k.");
  });
});
