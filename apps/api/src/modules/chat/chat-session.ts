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

export async function setChatSessionTitleIfEmpty(input: {
  userId: string;
  sessionId: string;
  title: string;
}): Promise<void> {
  const title = input.title.trim().slice(0, 48);
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
