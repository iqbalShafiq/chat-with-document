import { parseMessage, type Message } from "@anvia/core";
import {
  citationsToJsonValue,
  extractTextFromMessageJson,
  parseCitationsFromText,
} from "@anreal/agent";
import { prisma } from "../../utils/prisma.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveCitationsMetadata(
  message: Message,
  existingMeta: Record<string, unknown>,
): Array<Record<string, string | number>> | undefined {
  // Prefer dual-written metadata when present and valid.
  if (Array.isArray(existingMeta.citations)) {
    return existingMeta.citations as Array<Record<string, string | number>>;
  }

  if (message.role !== "assistant") return undefined;

  const rawText = extractTextFromMessageJson(message);
  if (!rawText.includes("[[cite:") && !rawText.includes("```citations")) {
    return undefined;
  }

  const { citations } = parseCitationsFromText(rawText);
  if (citations.length === 0) return undefined;
  return citationsToJsonValue(citations);
}

/**
 * Load session memory messages and inject stable UI metadata:
 * - createdAt (ISO from AgentMemoryMessage.createdAt)
 * - memoryPosition (row position)
 * - native Anvia `metadata.anvia.memoryCompaction` summary rows are returned
 *   as persisted system messages; no synthetic divider is inserted
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
  userId: string,
): Promise<Message[]> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId, userId);

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

  const output: Message[] = [];
  for (const row of rows) {
    // This raw query exists to preserve row positions and timestamps for the
    // UI, but it must retain the same strict v1 validation as PrismaMemoryStore.
    // Legacy v0 JSON is normalized offline before workers/readers run.
    const message = parseMessage(row.message);

    // Tool / system rows must stay metadata-free for Anvia UI conversion.
    if (row.role === "tool" || message.role === "tool") {
      output.push(message);
    } else if (row.role === "system" || message.role === "system") {
      output.push(message);
    } else {
      const createdAt = row.createdAt.toISOString();
      const memoryPosition = row.position;

      const existingMeta = isJsonObject(message.metadata)
        ? message.metadata
        : message.metadata === undefined
          ? {}
          : { value: message.metadata };

      const citations = resolveCitationsMetadata(message, existingMeta);

      output.push({
        ...message,
        metadata: {
          ...existingMeta,
          createdAt:
            typeof existingMeta.createdAt === "string"
              ? existingMeta.createdAt
              : createdAt,
          memoryPosition,
          ...(citations !== undefined ? { citations } : {}),
        },
      } as Message);
    }
  }

  return output;
}
