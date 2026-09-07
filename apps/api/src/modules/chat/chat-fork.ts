import type { Prisma } from "../../generated/prisma/client.js";
import { parseMessage } from "@anvia/core";
import { z } from "zod";

import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

const forkedFromSchema = z
  .object({
    token: z.string().min(1).max(256),
    title: z.string().max(200),
  })
  .strict();

const textPartSchema = z
  .object({ type: z.literal("text"), text: z.string().max(32000) })
  .catchall(z.unknown());

const forkMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    content: z.string().max(32000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

export const forkBodySchema = z
  .object({
    sessionId: z.string().uuid(),
    forkedFrom: forkedFromSchema,
    messages: z.array(forkMessageSchema).max(40),
    firstMessage: z.string().trim().min(1).max(32000),
  })
  .strict();

export type ForkBody = z.infer<typeof forkBodySchema>;

export type ForkResult = {
  sessionId: string;
  seededMessages: number;
};

/**
 * Seed a viewer's fork session from a frozen share snapshot. The fork is a
 * fully independent session (own ChatSession row + own memory scope): later
 * revoke/delete of the source share never touches it. Provenance is stored
 * as frozen text metadata, not a live link.
 *
 * Memory write uses the same Anvia memory-session/message tables the chat
 * pipeline owns; the first user message is persisted immediately so the
 * session is non-empty even if the viewer never sends a second turn.
 */
export async function seedForkSession(input: {
  userId: string;
  body: ForkBody;
}): Promise<ForkResult> {
  const session = await prisma.chatSession.findFirst({
    where: { id: input.body.sessionId, userId: input.userId },
    select: { id: true, title: true },
  });
  if (!session) {
    throw new Error("Fork target session not found");
  }

  if (!session.title) {
    const title = `Fork of ${input.body.forkedFrom.title}`.slice(0, 48);
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { title },
    });
  }

  const scopeKey = createDefaultMemoryScopeKey(session.id, input.userId);
  const memorySession = await prisma.agentMemorySession.upsert({
    where: { scopeKey },
    create: {
      scopeKey,
      sessionId: session.id,
      userId: input.userId,
      metadata: {
        forkedFrom: {
          token: input.body.forkedFrom.token,
          title: input.body.forkedFrom.title,
        },
      },
    },
    update: {},
    select: { id: true },
  });

  let position = 0;
  let turn = 0;
  const runId = `fork-${input.body.forkedFrom.token.slice(0, 12)}`;
  const toJson = (value: unknown): Prisma.InputJsonValue =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  // Validate through the same strict v1 message schema readers use, so a
  // forked session always loads (unknown shapes throw here, not on every
  // later history read). Stored rows use completion `content` (string or
  // content parts) — never UI `parts`.
  const textOf = (message: {
    content?: string;
    parts?: Array<{ text?: string }>;
  }): string => {
    if (typeof message.content === "string") return message.content;
    const texts = (message.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return texts;
  };
  const toMessageJson = (value: unknown): Prisma.InputJsonValue =>
    toJson(parseMessage(value));
  const seedRows = input.body.messages.map((message) => {
    const text = textOf(message).slice(0, 32000);
    if (!text.trim()) return null;
    const content = textPartSchema.safeParse({ type: "text", text }).success
      ? [{ type: "text", text }]
      : text;
    return {
      memorySessionId: memorySession.id,
      runId,
      turn: turn++,
      role: message.role,
      message: toMessageJson({
        role: message.role,
        content,
        ...(message.metadata ? { metadata: message.metadata } : {}),
      }),
      position: position++,
    };
  });
  const seeded = seedRows.filter(
    (row): row is NonNullable<typeof row> => row !== null,
  );
  seeded.push({
    memorySessionId: memorySession.id,
    runId,
    turn: turn++,
    role: "user",
    message: toMessageJson({
      role: "user",
      content: input.body.firstMessage,
    }),
    position: position++,
  });

  await prisma.agentMemoryMessage.createMany({ data: seeded });

  return { sessionId: session.id, seededMessages: seeded.length };
}
