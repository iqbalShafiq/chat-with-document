import { prisma } from "../../utils/prisma.js";

export class ChatSessionNotFoundError extends Error {
  readonly code = "CHAT_SESSION_NOT_FOUND";
  constructor(message = "Chat session not found") {
    super(message);
    this.name = "ChatSessionNotFoundError";
  }
}

export class ProjectMembershipError extends Error {
  readonly code = "PROJECT_MEMBERSHIP_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ProjectMembershipError";
  }
}

export type ChatSessionRow = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Ensure a ChatSession row exists for this client session UUID.
 * - New standalone: projectId null
 * - New in project: validates ownership, sets projectId, bulk-links ready corpus
 * - Existing: returns as-is (does not reassign projectId)
 */
export async function ensureChatSession(input: {
  sessionId: string;
  userId: string;
  /** When creating: optional project membership. Ignored if row already exists. */
  projectId?: string | null;
}): Promise<ChatSessionRow> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const existing = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: input.userId },
  });
  if (existing) {
    return existing;
  }

  // Legacy: memory may exist without ChatSession (pre-migration tabs).
  // Create standalone unless projectId explicitly provided for a brand-new id.
  let projectId: string | null = null;
  if (input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId: input.userId },
      select: { id: true },
    });
    if (!project) {
      throw new ProjectMembershipError("Project not found");
    }
    projectId = project.id;
  }

  try {
    const created = await prisma.chatSession.create({
      data: {
        id: sessionId,
        userId: input.userId,
        projectId,
      },
    });

    if (projectId) {
      await autoLinkReadyProjectDocuments({
        userId: input.userId,
        sessionId,
        projectId,
      });
    }

    return created;
  } catch (error) {
    // Concurrent first-touch: another request won the insert.
    if (isUniqueViolation(error)) {
      const winner = await prisma.chatSession.findFirst({
        where: { id: sessionId, userId: input.userId },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

/** Membership for an existing chat, or null if no durable row yet. */
export async function getSessionProjectId(
  userId: string,
  sessionId: string,
): Promise<string | null | undefined> {
  const row = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!row) return undefined;
  return row.projectId;
}

/** Bulk-link all ready project corpus docs to a project chat (hybrid default). */
export async function autoLinkReadyProjectDocuments(input: {
  userId: string;
  sessionId: string;
  projectId: string;
}): Promise<number> {
  const docs = await prisma.document.findMany({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      status: "ready",
    },
    select: { id: true },
  });

  if (docs.length === 0) return 0;

  await prisma.documentSession.createMany({
    data: docs.map((d) => ({
      documentId: d.id,
      sessionId: input.sessionId,
      userId: input.userId,
    })),
    skipDuplicates: true,
  });

  return docs.length;
}

export async function getChatSession(
  userId: string,
  sessionId: string,
): Promise<ChatSessionRow> {
  const row = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!row) throw new ChatSessionNotFoundError();
  return row;
}

/**
 * Resolve session for chat POST: ensure exists (standalone if new), return membership.
 * Never trusts client projectId for existing sessions.
 */
export async function resolveChatSessionForAgent(input: {
  userId: string;
  sessionId: string;
}): Promise<ChatSessionRow> {
  return ensureChatSession({
    sessionId: input.sessionId,
    userId: input.userId,
    projectId: null,
  });
}

export async function touchChatSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: sessionId, userId },
    data: { updatedAt: new Date() },
  });
}

export const TITLE_MAX = 48;

/** Sidebar title normalization: trim, collapse whitespace, cap at 48 chars. */
export function normalizeSessionTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return Array.from(collapsed).slice(0, TITLE_MAX).join("");
}

/**
 * Rename a chat session (user-scoped). Throws ChatSessionNotFoundError when
 * the session does not exist for this user.
 */
export async function renameChatSession(input: {
  userId: string;
  sessionId: string;
  title: string;
}): Promise<ChatSessionRow> {
  const title = normalizeSessionTitle(input.title);
  if (!title) throw new Error("title is required");
  const updated = await prisma.chatSession.updateMany({
    where: { id: input.sessionId, userId: input.userId },
    data: { title },
  });
  if (updated.count === 0) throw new ChatSessionNotFoundError();
  const row = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
  });
  if (!row) throw new ChatSessionNotFoundError();
  return row;
}

export async function setChatSessionTitleIfEmpty(input: {
  userId: string;
  sessionId: string;
  title: string;
}): Promise<void> {
  const title = Array.from(input.title.trim()).slice(0, TITLE_MAX).join("");
  if (!title) return;
  await prisma.chatSession.updateMany({
    where: {
      id: input.sessionId,
      userId: input.userId,
      OR: [{ title: null }, { title: "" }],
    },
    data: { title },
  });
}

/**
 * Hard-delete chat sessions (empty drafts). Cleans memory, usage, and session links.
 * Does not delete Documents (only DocumentSession links for these session ids).
 */
export async function deleteChatSessionsHard(
  userId: string,
  sessionIds: string[],
): Promise<number> {
  const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return 0;

  await prisma.$transaction(async (tx) => {
    await tx.documentSession.deleteMany({
      where: { userId, sessionId: { in: ids } },
    });
    await tx.sessionImageContext.deleteMany({
      where: { userId, sessionId: { in: ids } },
    });
    await tx.sessionContextSnippet.deleteMany({
      where: { userId, sessionId: { in: ids } },
    });
    await tx.agentUsageEvent.deleteMany({
      where: { userId, sessionId: { in: ids } },
    });
    await tx.agentMemorySession.deleteMany({
      where: { sessionId: { in: ids } },
    });
    await tx.chatSession.deleteMany({
      where: { userId, id: { in: ids } },
    });
  });

  return ids.length;
}

/**
 * Empty draft = ChatSession with zero agent memory messages (true "New chat").
 * Ordered newest first.
 */
export async function findEmptyChatSessions(
  userId: string,
  projectId: string | null,
): Promise<ChatSessionRow[]> {
  const rows = await prisma.chatSession.findMany({
    where: {
      userId,
      projectId,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (rows.length === 0) return [];

  const withMessages = await prisma.agentMemorySession.findMany({
    where: {
      sessionId: { in: rows.map((r) => r.id) },
      messages: { some: {} },
    },
    select: { sessionId: true },
  });
  const nonEmpty = new Set(withMessages.map((m) => m.sessionId));
  return rows.filter((r) => !nonEmpty.has(r.id));
}

/**
 * One empty draft per (user, project|standalone). Reuses the newest empty;
 * prunes older empty duplicates so they cannot stack.
 */
export async function getOrCreateEmptyChatSession(input: {
  userId: string;
  projectId?: string | null;
}): Promise<ChatSessionRow> {
  let projectId: string | null = null;
  if (input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId: input.userId },
      select: { id: true },
    });
    if (!project) {
      throw new ProjectMembershipError("Project not found");
    }
    projectId = project.id;
  }

  const empties = await findEmptyChatSessions(input.userId, projectId);
  if (empties.length > 0) {
    const [keeper, ...extras] = empties;
    if (extras.length > 0) {
      await deleteChatSessionsHard(
        input.userId,
        extras.map((e) => e.id),
      );
    }
    return keeper!;
  }

  return ensureChatSession({
    sessionId: crypto.randomUUID(),
    userId: input.userId,
    projectId,
  });
}
