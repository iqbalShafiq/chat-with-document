import { randomBytes } from "node:crypto";

import { prisma } from "../../utils/prisma.js";
import { getChatSession } from "./chat-session.js";
import { loadEnrichedMemoryMessages } from "./enrich-memory-messages.js";

export class ChatShareNotFoundError extends Error {
  readonly code = "CHAT_SHARE_NOT_FOUND";
  constructor(message = "Shared link not found or no longer active") {
    super(message);
    this.name = "ChatShareNotFoundError";
  }
}

export type ChatShareRow = {
  id: string;
  token: string;
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

/** Unguessable public token: 256 bits, URL-safe, never the session id. */
export function generateShareToken(): string {
  return randomBytes(32)
    .toString("base64url")
    .replace(/[^A-Za-z0-9_-]/g, "x");
}

function toRow(row: {
  id: string;
  token: string;
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}): ChatShareRow {
  return { ...row };
}

/**
 * Create a frozen public snapshot of the session's current history.
 * Each call mints a new token + snapshot row (multi-link per session).
 */
export async function createChatShare(input: {
  userId: string;
  sessionId: string;
}): Promise<ChatShareRow & { urlPath: string }> {
  const session = await getChatSession(input.userId, input.sessionId);
  const messages = await loadEnrichedMemoryMessages(
    input.sessionId,
    input.userId,
  );
  const created = await prisma.chatShare.create({
    data: {
      token: generateShareToken(),
      sessionId: session.id,
      userId: input.userId,
      snapshot: messages as unknown as object,
      title: session.title,
    },
  });
  return { ...toRow(created), urlPath: `/share/${created.token}` };
}

export type PublicShareSnapshot = {
  token: string;
  title: string | null;
  createdAt: string;
  ownerName: string | null;
  messages: unknown;
};

/**
 * Resolve a public share for anonymous or signed-in readers. Throws
 * ChatShareNotFoundError when the token is unknown, revoked, or its source
 * session was deleted (cascade removes the row, so this is belt-and-braces).
 */
export async function getPublicShareSnapshot(
  token: string,
): Promise<PublicShareSnapshot> {
  const row = await prisma.chatShare.findUnique({
    where: { token: token.trim() },
    include: {
      session: { select: { id: true, title: true } },
    },
  });
  if (!row || row.revokedAt || !row.session) {
    throw new ChatShareNotFoundError();
  }
  const owner = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { name: true },
  });
  return {
    token: row.token,
    title: row.title ?? row.session.title,
    createdAt: row.createdAt.toISOString(),
    ownerName: owner?.name ?? null,
    messages: row.snapshot,
  };
}

/** Whether the session currently has at least one active (non-revoked) link. */
export async function hasActiveChatShare(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const count = await prisma.chatShare.count({
    where: { userId, sessionId, revokedAt: null },
  });
  return count > 0;
}

/**
 * Deactivate ALL public links of a session at once. There is intentionally
 * no per-link revoke and no link listing: the owner never sees old tokens.
 */
export async function deactivateChatShares(input: {
  userId: string;
  sessionId: string;
}): Promise<{ revoked: number }> {
  await getChatSession(input.userId, input.sessionId);
  const result = await prisma.chatShare.updateMany({
    where: {
      userId: input.userId,
      sessionId: input.sessionId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count };
}
