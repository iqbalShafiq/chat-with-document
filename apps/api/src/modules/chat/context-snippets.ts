import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma as prismaClient } from "../../utils/prisma.js";

export type ContextSnippetSourceRole = "user" | "assistant";

export type ContextSnippetRecord = {
  id: string;
  userId: string;
  sessionId: string;
  text: string;
  sourceRole: ContextSnippetSourceRole;
  createdAt: Date;
  updatedAt: Date;
};

export type ContextSnippetStorePrisma = Pick<
  PrismaClient,
  "chatSession" | "sessionContextSnippet"
>;

export const MAX_CONTEXT_SNIPPET_CHARS = 2000;

export class ContextSnippetSessionNotFoundError extends Error {
  constructor() {
    super("session not found");
  }
}

/** Validate + shape the PUT body. Text length is enforced here and in the store. */
export function parseContextSnippetBody(
  body: unknown,
): { text: string; sourceRole: ContextSnippetSourceRole } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  if (record.text.trim().length === 0) return null;
  if (Array.from(record.text).length > MAX_CONTEXT_SNIPPET_CHARS) return null;
  if (record.sourceRole !== "user" && record.sourceRole !== "assistant") {
    return null;
  }
  return { text: record.text, sourceRole: record.sourceRole };
}

/**
 * Agent context block text. Kept pure so build-run-input stays thin and the
 * wording is unit-testable.
 */
export function formatContextSnippetBlock(snippet: {
  text: string;
  sourceRole: ContextSnippetSourceRole;
}): string {
  const origin =
    snippet.sourceRole === "assistant"
      ? "from the assistant"
      : "from the user";
  return [
    "User-selected context",
    "The user pinned this excerpt as additional context for this message. Treat it as high-priority context, above the rest of the conversation:",
    `1. (${origin}) ${snippet.text}`,
  ].join("\n");
}

export function createContextSnippetStore(deps: {
  prisma: ContextSnippetStorePrisma;
}) {
  const sessionOwnedByUser = async (input: {
    userId: string;
    sessionId: string;
  }): Promise<boolean> => {
    const session = await deps.prisma.chatSession.findFirst({
      where: { id: input.sessionId, userId: input.userId },
      select: { id: true },
    });
    return session !== null;
  };

  return {
    async getSessionContextSnippet(input: {
      userId: string;
      sessionId: string;
    }): Promise<ContextSnippetRecord | null> {
      if (!(await sessionOwnedByUser(input))) return null;
      const row = await deps.prisma.sessionContextSnippet.findUnique({
        where: { sessionId: input.sessionId },
      });
      return row as ContextSnippetRecord | null;
    },

    async upsertContextSnippet(input: {
      userId: string;
      sessionId: string;
      text: string;
      sourceRole: ContextSnippetSourceRole;
    }): Promise<ContextSnippetRecord> {
      if (Array.from(input.text).length > MAX_CONTEXT_SNIPPET_CHARS) {
        throw new Error(
          `context snippet exceeds ${MAX_CONTEXT_SNIPPET_CHARS} characters`,
        );
      }
      if (!(await sessionOwnedByUser(input))) {
        throw new ContextSnippetSessionNotFoundError();
      }
      const row = await deps.prisma.sessionContextSnippet.upsert({
        where: { sessionId: input.sessionId },
        create: {
          userId: input.userId,
          sessionId: input.sessionId,
          text: input.text,
          sourceRole: input.sourceRole,
        },
        update: { text: input.text, sourceRole: input.sourceRole },
      });
      return row as ContextSnippetRecord;
    },

    async removeContextSnippet(input: {
      userId: string;
      snippetId: string;
    }): Promise<boolean> {
      const result = await deps.prisma.sessionContextSnippet.deleteMany({
        where: { id: input.snippetId, userId: input.userId },
      });
      return result.count > 0;
    },

    async clearSessionContextSnippet(input: {
      userId: string;
      sessionId: string;
    }): Promise<void> {
      await deps.prisma.sessionContextSnippet.deleteMany({
        where: { userId: input.userId, sessionId: input.sessionId },
      });
    },
  };
}

export type ContextSnippetStore = ReturnType<typeof createContextSnippetStore>;

let contextSnippetStore: ContextSnippetStore | null = null;

/** Process-lifetime store backed by the shared prisma client. */
export function getContextSnippetStore(): ContextSnippetStore {
  if (!contextSnippetStore) {
    contextSnippetStore = createContextSnippetStore({ prisma: prismaClient });
  }
  return contextSnippetStore;
}
