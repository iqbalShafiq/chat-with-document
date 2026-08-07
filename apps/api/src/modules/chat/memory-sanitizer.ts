import type { JsonObject, MemoryStore, Message } from "@anvia/core";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { buildCompactedView, loadCompactionSegments } from "./compaction.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip image content parts from tool messages before persistence so base64
 * never lands in the memory table (it is replayed to the model otherwise).
 * In the anvia shape, image parts live nested inside tool_result parts
 * (ToolResult.content is ToolResultContent[]: text | image), not at the
 * message level, so the strip recurses one level. Text parts, tool_result
 * ids/callId pairing and message shape are preserved; a stripped-empty
 * nested content gets an empty text part — the valid no-op variant per
 * memory-prisma's isToolResultContent — instead of a bare message-level
 * part, which isToolContent would reject.
 */
function sanitizeToolResultContent(content: unknown[]): unknown[] {
  const filtered = content.filter(
    (part) => !(isRecord(part) && part.type === "image"),
  );
  if (filtered.length === 0) {
    filtered.push({ type: "text", text: "" });
  }
  return filtered;
}

function sanitizeMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== "tool") return message;
    if (!Array.isArray(message.content)) return message;

    const content = message.content.map((part) => {
      if (!isRecord(part) || part.type !== "tool_result") return part;
      if (!Array.isArray(part.content)) return part;
      return {
        ...part,
        content: sanitizeToolResultContent(part.content),
      };
    });
    return { ...message, content };
  });
}

/**
 * memory-prisma's append/recordError upsert the session with
 * `metadata: context.metadata ?? {}`, which would clobber the compaction
 * segments stored in AgentMemorySession.metadata. Re-read the persisted
 * metadata and pass it through so segments survive every write.
 */
async function persistedSessionMetadata(
  prisma: PrismaClient,
  context: { sessionId: string; userId?: string | null; metadata?: unknown },
): Promise<JsonObject> {
  const scopeKey = createDefaultMemoryScopeKey(context.sessionId, context.userId);
  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { metadata: true },
  });
  const persisted = session && isRecord(session.metadata) ? (session.metadata as JsonObject) : {};
  const callerMetadata = isRecord(context.metadata) ? (context.metadata as JsonObject) : {};
  return { ...persisted, ...callerMetadata };
}

/** The agent must never see error artifacts (kind:"error" rows). */
export function createSanitizedMemoryStore(prisma: PrismaClient): MemoryStore {
  const inner = createPrismaMemoryStore(prisma);
  return {
    kind: inner.kind,
    inspector: inner.inspector,
    load: async (context) => {
      const scopeKey = createDefaultMemoryScopeKey(
        context.sessionId,
        context.userId,
      );
      const session = await prisma.agentMemorySession.findUnique({
        where: { scopeKey },
        select: { id: true },
      });
      if (!session) return [];
      const rows = await prisma.agentMemoryMessage.findMany({
        where: { memorySessionId: session.id },
        orderBy: { position: "asc" },
        select: { position: true, message: true },
      });
      const filtered = rows
        .map((row) => ({ position: row.position, message: row.message as Message }))
        .filter(
          (row) =>
            !(
              isRecord(row.message) &&
              isRecord(row.message.metadata) &&
              row.message.metadata.kind === "error"
            ),
        );
      const segments = await loadCompactionSegments(
        context.sessionId,
        context.userId,
      );
      return buildCompactedView(filtered, segments);
    },
    append: async (input) => {
      await inner.append({
        ...input,
        context: {
          ...input.context,
          metadata: await persistedSessionMetadata(prisma, input.context),
        },
        messages: sanitizeMessages(input.messages) as Message[],
      });
    },
    clear: (context) => inner.clear(context),
    recordError: async (input) => {
      await inner.recordError({
        ...input,
        context: {
          ...input.context,
          metadata: await persistedSessionMetadata(prisma, input.context),
        },
      });
    },
  } as MemoryStore;
}
