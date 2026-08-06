import type { MemoryStore, Message } from "@anvia/core";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import type { PrismaClient } from "../../generated/prisma/client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip image content parts from tool messages before persistence so base64
 * never lands in the memory table (it is replayed to the model otherwise).
 * Text parts and message shape are preserved; callId pairing stays intact.
 */
function sanitizeMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== "tool") return message;
    if (!Array.isArray(message.content)) return message;

    const content = message.content.filter(
      (part) => !(isRecord(part) && part.type === "image"),
    );
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }
    return { ...message, content };
  });
}

export function createSanitizedMemoryStore(prisma: PrismaClient): MemoryStore {
  const inner = createPrismaMemoryStore(prisma);
  return {
    kind: inner.kind,
    inspector: inner.inspector,
    load: (context) => inner.load(context),
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
