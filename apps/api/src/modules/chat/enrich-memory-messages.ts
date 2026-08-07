import type { Message } from "@anvia/core/completion";
import {
  citationsToJsonValue,
  extractTextFromMessageJson,
  parseCitationsFromText,
} from "@assingment/agent";
import { prisma } from "../../utils/prisma.js";
import { loadCompactionSegments } from "./compaction.js";
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
 * - synthetic `metadata.kind === "summary"` divider rows after the row at
 *   each compaction segment's upToPosition (all rows are returned unchanged)
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

  // Synthetic divider per compaction segment, placed after the row at
  // upToPosition. Must NOT carry memoryPosition/clientMessageId metadata so
  // it can never be a truncate target (canTargetMessageForTruncate checks
  // those fields).
  const segments = await loadCompactionSegments(sessionId, userId);
  const dividerByPosition = new Map<number, Message>();
  for (const segment of segments) {
    dividerByPosition.set(segment.upToPosition, {
      role: "system",
      content: segment.kind === "summarized" ? segment.summary : "",
      metadata: { kind: "summary" },
    } as Message);
  }

  const output: Message[] = [];
  for (const row of rows) {
    const message = row.message as Message;

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

    // Row positions are contiguous and compaction never deletes rows, so the
    // row at a segment's upToPosition always exists; skip defensively.
    const divider = dividerByPosition.get(row.position);
    if (divider !== undefined) output.push(divider);
  }

  return output;
}
