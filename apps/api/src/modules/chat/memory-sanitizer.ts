import type { MemoryStore, Message } from "@anvia/core";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import type { PrismaClient } from "../../generated/prisma/client.js";

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

/** The agent must never see error artifacts (kind:"error" rows). */
function isErrorArtifact(message: unknown): boolean {
  return (
    isRecord(message) &&
    isRecord(message.metadata) &&
    message.metadata.kind === "error"
  );
}

export function createSanitizedMemoryStore(prisma: PrismaClient): MemoryStore {
  const inner = createPrismaMemoryStore(prisma);
  return {
    kind: inner.kind,
    inspector: inner.inspector,
    load: async (context) => {
      const loaded = await inner.load(context);
      return loaded.filter((message) => !isErrorArtifact(message));
    },
    append: async (input) => {
      await inner.append({
        ...input,
        messages: sanitizeMessages(input.messages) as Message[],
      });
    },
    clear: (context) => inner.clear(context),
    recordError: (input) => inner.recordError(input),
  } as MemoryStore;
}
