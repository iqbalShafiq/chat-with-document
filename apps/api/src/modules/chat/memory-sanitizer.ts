import {
  parseMessage,
  type JsonObject,
  type MemoryScope,
  type MemoryStore,
  type Message,
} from "@anvia/core";
import { PrismaMemoryStore } from "@anvia/memory-prisma";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { buildCompactedView, loadCompactionSegments } from "./compaction.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip embedded data-backed rich parts from tool messages before persistence
 * so base64 never lands in the memory table (it is replayed to the model
 * otherwise). URL-backed and textual file parts remain available to the UI.
 * In the v1 shape, rich output lives inside tool-result output content
 * (ToolResultOutput.content is TextPart | FilePart[]), not at the message
 * level, so the strip recurses one level. Text parts, tool-result ids/callId
 * pairing and message shape are preserved; stripped-empty content gets an
 * empty text part, the valid no-op v1 representation.
 */
function sanitizeToolResultPart(part: unknown): unknown {
  if (!isRecord(part) || part.type !== "tool-result") return part;
  const output = part.output;
  if (!isRecord(output) || output.type !== "content") return part;
  if (!Array.isArray(output.value)) return part;

  // v1 represents rich tool output as `file` parts inside a content output.
  // Only data-backed files contain embedded bytes; retain URL/text files and
  // their metadata for the file UX. Keep the `content` output shape and add a
  // valid empty text part when every embedded part was removed.
  const filtered = output.value.filter(
    (content) =>
      !(
        isRecord(content) &&
        content.type === "file" &&
        isRecord(content.data) &&
        content.data.type === "data"
      ),
  );
  if (filtered.length === output.value.length) return part;
  return {
    ...part,
    output: {
      ...output,
      value: filtered.length > 0 ? filtered : [{ type: "text", text: "" }],
    },
  };
}

function isNonVisionUnsafePart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  // A text-only model cannot accept image input even when the image is
  // URL-backed. Embedded data-backed files are also unsafe to replay, and
  // image/* files are image input regardless of their backing source.
  if (value.type === "image") return true;
  if (value.type !== "file") return false;
  if (isRecord(value.data) && value.data.type === "data") return true;
  return typeof value.mediaType === "string" && value.mediaType.startsWith("image/");
}

function sanitizeNonVisionToolResultPart(part: unknown): unknown {
  if (!isRecord(part) || part.type !== "tool-result") return part;
  const output = part.output;
  if (!isRecord(output) || output.type !== "content") return part;
  if (!Array.isArray(output.value)) return part;
  const filtered = output.value.filter((content) => !isNonVisionUnsafePart(content));
  if (filtered.length === output.value.length) return part;
  return {
    ...part,
    output: {
      ...output,
      value: filtered.length > 0 ? filtered : [{ type: "text", text: "" }],
    },
  };
}

function sanitizePersistedContentPart(part: unknown): unknown | undefined {
  const toolResult = sanitizeToolResultPart(part);
  if (toolResult !== part) return toolResult;
  if (!isRecord(part)) return part;
  if (part.type === "image") {
    return isRecord(part.image) && part.image.type === "data" ? undefined : part;
  }
  if (part.type === "file") {
    return isRecord(part.data) && part.data.type === "data" ? undefined : part;
  }
  return part;
}

function sanitizeMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;

    let changed = false;
    const content = message.content.flatMap((part) => {
      const sanitized = sanitizePersistedContentPart(part);
      if (sanitized !== part) changed = true;
      return sanitized === undefined ? [] : [sanitized];
    });
    if (content.length === 0 && message.role !== "tool") {
      content.push({ type: "text", text: "" });
      changed = true;
    }
    return changed ? { ...message, content } : message;
  });
}

export type SanitizedMemoryStore = MemoryStore & {
  validate(): Promise<void>;
};

/** Cache startup validation so a worker lifecycle performs it exactly once. */
export function createMemoryValidationGate(
  validate: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= validate();
    return pending;
  };
}

/**
 * memory-prisma's append/recordError upsert the session with
 * `metadata: context.metadata ?? {}`, which would clobber the compaction
 * segments stored in AgentMemorySession.metadata. Re-read the persisted
 * metadata and pass it through so segments survive every write.
 */
async function persistedSessionMetadata(
  prisma: PrismaClient,
  scope: MemoryScope,
): Promise<JsonObject> {
  const scopeKey = createDefaultMemoryScopeKey(scope.sessionId, scope.userId);
  const session = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { metadata: true },
  });
  const persisted = session && isRecord(session.metadata) ? (session.metadata as JsonObject) : {};
  const callerMetadata = isRecord(scope.metadata) ? (scope.metadata as JsonObject) : {};
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
 * Drop every image part and image-like file part from the loaded model view
 * (e.g. a user message with pinned context images stored when a vision model
 * ran). The persisted rows are untouched — a later vision-model run still
 * gets them. Non-image URL/text files remain available for file UX. A
 * message whose content becomes empty gets an empty text part.
 */
function stripImageParts(message: Message): Message {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content: unknown[] =
    message.role === "tool"
      ? message.content.map((part) => {
          const sanitized = sanitizeNonVisionToolResultPart(part);
          if (sanitized !== part) changed = true;
          return sanitized;
        })
      : message.content.filter((part) => {
          const keep = !isNonVisionUnsafePart(part);
          if (!keep) changed = true;
          return keep;
        });
  if (!changed) return message;
  if (content.length === 0 && message.role !== "tool") {
    content.push({ type: "text", text: "" });
  }
  return { ...message, content } as unknown as Message;
}

/**
 * Wrap a memory store so `load` returns messages without image content —
 * used when the run's model cannot accept image input (a text-only model
 * would 404 on image parts replayed from memory). Non-destructive: rows in
 * the DB keep their images for future vision-model runs.
 */
export function createNonVisionMemoryProxy(inner: MemoryStore): MemoryStore {
  const proxy: MemoryStore = {
    inspector: inner.inspector,
    compaction: inner.compaction,
    load: async ({ scope }) => {
      const messages = await inner.load({ scope });
      return messages.map(stripImageParts);
    },
    append: (input) => inner.append(input),
    clear: (input) => inner.clear(input),
  };
  if (inner.recordError) {
    proxy.recordError = (input) => inner.recordError!(input);
  }
  return proxy;
}

/** The agent must never see error artifacts (kind:"error" rows). */
export function createSanitizedMemoryStore(
  prisma: PrismaClient,
): SanitizedMemoryStore {
  const inner = new PrismaMemoryStore({
    client: prisma,
    errorPolicy: "store",
    validateMessages: true,
    // This is byte-for-byte equivalent to the v1 default, and makes the
    // existing application's scope-key contract explicit at the boundary.
    scopeKey: ({ scope }) =>
      createDefaultMemoryScopeKey(scope.sessionId, scope.userId),
  });
  return {
    kind: inner.kind,
    inspector: inner.inspector,
    validate: () => inner.validate(),
    // Official @anvia/memory-prisma compaction deletes prefix rows. This app
    // stores segments in session metadata and must never enable that path.
    compaction: undefined,
    load: async ({ scope }) => {
      const scopeKey = createDefaultMemoryScopeKey(
        scope.sessionId,
        scope.userId,
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
          // Keep the app-owned position/compaction view, but enforce the same
          // strict v1 parser as PrismaMemoryStore.load at this raw-query
          // boundary. Legacy v0 rows must be normalized offline first.
          message: stripReasoningParts(parseMessage(row.message)),
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
        scope.sessionId,
        scope.userId,
      );
      return buildCompactedView(filtered, segments);
    },
    append: async (input) => {
      await inner.append({
        ...input,
        scope: {
          ...input.scope,
          metadata: await persistedSessionMetadata(prisma, input.scope),
        },
        messages: sanitizeMessages(input.messages) as Message[],
      });
    },
    clear: ({ scope }) => inner.clear({ scope }),
    recordError: async (input) => {
      if (!inner.recordError) return;
      await inner.recordError({
        ...input,
        scope: {
          ...input.scope,
          metadata: await persistedSessionMetadata(prisma, input.scope),
        },
        messages: sanitizeMessages(input.messages) as Message[],
      });
    },
  } as SanitizedMemoryStore;
}

export async function validateSanitizedMemoryStore(
  prisma: PrismaClient,
): Promise<void> {
  await createSanitizedMemoryStore(prisma).validate();
}
