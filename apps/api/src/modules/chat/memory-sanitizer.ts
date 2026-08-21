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

/**
 * Drop `reasoning` parts from assistant messages in the agent view. Replaying
 * stored reasoning text makes Anvia emit `reasoning` items with a non-empty
 * `content` array, which some providers (e.g. DeepSeek via OpenRouter) reject
 * ("expected an array with maximum length 0"). The reasoning text is UI-only —
 * the model gets the summary alongside it and does not need the raw chain.
 */
function stripReasoningParts(message: Message): Message {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const content = message.content.filter((part) => part.type !== "reasoning");
  if (content.length === message.content.length) return message;
  return { ...message, content };
}

/**
 * Drop message-level image content parts from the loaded view (e.g. a user
 * message with pinned context images stored when a vision model ran). The
 * persisted rows are untouched — a later vision-model run still gets them.
 * A message whose content becomes empty gets an empty text part (the valid
 * no-op variant per memory-prisma's isToolContent).
 */
function stripImageParts(message: Message): Message {
  if (!Array.isArray(message.content)) return message;
  const content: unknown[] = message.content.filter(
    (part) => !(isRecord(part) && part.type === "image"),
  );
  if (content.length === message.content.length) return message;
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { ...message, content } as unknown as Message;
}

/**
 * Wrap a memory store so `load` returns messages without image content —
 * used when the run's model cannot accept image input (a text-only model
 * would 404 on image parts replayed from memory). Non-destructive: rows in
 * the DB keep their images for future vision-model runs.
 */
export function createNonVisionMemoryProxy(inner: MemoryStore): MemoryStore {
  return {
    ...inner,
    load: async (context) => {
      const messages = await inner.load(context);
      return messages.map(stripImageParts);
    },
  } as MemoryStore;
}

/** The agent must never see error artifacts (kind:"error" rows). */
export function createSanitizedMemoryStore(prisma: PrismaClient): MemoryStore {
  const inner = createPrismaMemoryStore(prisma);
  return {
    kind: inner.kind,
    inspector: inner.inspector,
    // Official @anvia/memory-prisma compaction deletes prefix rows. This app
    // stores segments in session metadata and must never enable that path.
    compaction: undefined,
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
        .map((row) => ({
          position: row.position,
          message: stripReasoningParts(row.message as Message),
        }))
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
