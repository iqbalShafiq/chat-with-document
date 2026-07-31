import type { Message } from "@anvia/core/completion";
import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load session memory messages and inject stable UI metadata:
 * - createdAt (ISO from AgentMemoryMessage.createdAt)
 * - memoryPosition (row position)
 *
 * Existing message.metadata fields are preserved (shallow merge).
 *
 * Important: never attach metadata to **tool** messages. Anvia's
 * `coreMessagesToUIMessages` only merges tool results into assistant tool
 * parts when `message.metadata === undefined`. Injecting metadata breaks that
 * merge and leaves tool parts stuck at `input-available` ("Working") forever.
 */
export async function loadEnrichedMemoryMessages(
  sessionId: string,
): Promise<Message[]> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId);

  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });

  if (!session) {
    return [];
  }

  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: session.id },
    orderBy: { position: "asc" },
    select: {
      position: true,
      createdAt: true,
      message: true,
      role: true,
    },
  });

  return rows.map((row) => {
    const message = row.message as Message;

    // Tool / system rows must stay metadata-free for Anvia UI conversion.
    if (row.role === "tool" || message.role === "tool") {
      return message;
    }
    if (row.role === "system" || message.role === "system") {
      return message;
    }

    const createdAt = row.createdAt.toISOString();
    const memoryPosition = row.position;

    const existingMeta = isJsonObject(message.metadata)
      ? message.metadata
      : message.metadata === undefined
        ? {}
        : { value: message.metadata };

    return {
      ...message,
      metadata: {
        ...existingMeta,
        createdAt:
          typeof existingMeta.createdAt === "string"
            ? existingMeta.createdAt
            : createdAt,
        memoryPosition,
      },
    } as Message;
  });
}
