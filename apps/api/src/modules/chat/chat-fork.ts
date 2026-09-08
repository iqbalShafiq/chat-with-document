import type { Prisma } from "../../generated/prisma/client.js";
import { parseMessage } from "@anvia/core";
import { z } from "zod";

import { prisma } from "../../utils/prisma.js";
import { ChatShareNotFoundError } from "./chat-share.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

export const forkBodySchema = z
  .object({
    token: z.string().trim().min(1).max(256),
  })
  .strict();

export type ForkBody = z.infer<typeof forkBodySchema>;

export type ForkResult = {
  sessionId: string;
  seededMessages: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fork a frozen share snapshot into the viewer's own session. The snapshot
 * is read server-side from the share token — the client never supplies
 * history — so a fork always matches the shared link. The fork is fully
 * independent: later revoke/delete of the source never touches it.
 * Provenance is stored as frozen text metadata, not a live link.
 *
 * Memory write uses the same Anvia memory-session/message tables the chat
 * pipeline owns. Only the frozen history is seeded here; the viewer's first
 * follow-up streams later through the standard chat pipeline so model
 * selection, send smoothness, and AI reaction stay identical to a normal
 * chat.
 */
export async function seedForkSession(input: {
  userId: string;
  token: string;
}): Promise<ForkResult> {
  const token = input.token.trim();
  if (!token) throw new ChatShareNotFoundError();

  const share = await prisma.chatShare.findUnique({
    where: { token },
    include: {
      session: { select: { id: true, title: true } },
    },
  });
  if (!share || share.revokedAt || !share.session) {
    throw new ChatShareNotFoundError();
  }
  const title = share.title ?? share.session.title ?? "Shared chat";
  const snapshot = Array.isArray(share.snapshot) ? share.snapshot : [];

  const sessionId = crypto.randomUUID();
  await prisma.chatSession.create({
    data: {
      id: sessionId,
      userId: input.userId,
      projectId: null,
      title: `Fork of ${title}`.slice(0, 48),
    },
  });

  const scopeKey = createDefaultMemoryScopeKey(sessionId, input.userId);
  const memorySession = await prisma.agentMemorySession.upsert({
    where: { scopeKey },
    create: {
      scopeKey,
      sessionId,
      userId: input.userId,
      metadata: {
        forkedFrom: { token, title },
      },
    },
    update: {},
    select: { id: true },
  });

  let position = 0;
  let turn = 0;
  const runId = `fork-${token.slice(0, 12)}`;
  const toJson = (value: unknown): Prisma.InputJsonValue =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  // Validate through the same strict v1 message schema readers use, so a
  // forked session always loads. Stored rows use completion `content`
  // (string or content parts) — never UI `parts`.
  const toMessageJson = (value: unknown): Prisma.InputJsonValue =>
    toJson(parseMessage(value));
  const seedRows = snapshot.flatMap((message) => {
    if (!isRecord(message)) return [];
    let stored: unknown = null;
    try {
      stored = parseMessage(message);
    } catch {
      return [];
    }
    const role = (stored as { role?: unknown }).role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool" &&
      role !== "system"
    ) {
      return [];
    }
    return [
      {
        memorySessionId: memorySession.id,
        runId,
        turn: turn++,
        role,
        message: toJson(stored),
        position: position++,
      },
    ];
  });

  if (seedRows.length > 0) {
    await prisma.agentMemoryMessage.createMany({ data: seedRows });
  }

  return { sessionId, seededMessages: seedRows.length };
}
