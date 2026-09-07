import {
  parseMessage,
  type MemoryCompactionCapability,
  type MemoryStore,
  type Message,
} from "@anvia/core";
import { PrismaMemoryStore } from "@anvia/memory-prisma";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip embedded data-backed rich parts before a message reaches Prisma. */
function sanitizeToolResultPart(part: unknown): unknown {
  if (!isRecord(part) || part.type !== "tool-result") return part;
  const output = part.output;
  if (!isRecord(output) || output.type !== "content") return part;
  if (!Array.isArray(output.value)) return part;
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

function sanitizeMessages(messages: readonly Message[]): Message[] {
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
    return changed ? ({ ...message, content } as unknown as Message) : message;
  });
}

/** Remove provider-private reasoning output from model-facing history. */
function stripReasoningParts(message: Message): Message {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const content = message.content.filter((part) => part.type !== "reasoning");
  return content.length === message.content.length
    ? message
    : ({ ...message, content } as Message);
}

/** Remove image input from a text-only model view without mutating rows. */
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
  return { ...message, content } as Message;
}

function wrapCompaction(
  inner: MemoryCompactionCapability | undefined,
  sanitize: (message: Message) => Message,
): MemoryCompactionCapability | undefined {
  if (inner === undefined) return undefined;
  return {
    snapshot: async (input) => {
      const snapshot = await inner.snapshot(input);
      return {
        revision: snapshot.revision,
        messages: snapshot.messages.map(sanitize),
      };
    },
    replacePrefix: async (input) => {
      const replacement = sanitize(input.replacement);
      if (replacement !== input.replacement) {
        throw new Error("native memory compaction replacement contains unsafe parts");
      }
      return inner.replacePrefix(input);
    },
  };
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
 * Wrap a memory store for a text-only model. Native snapshots are sanitized in
 * addition to ordinary loads so Anvia's compactor cannot receive an image that
 * the run's provider cannot accept.
 */
export function createNonVisionMemoryProxy(inner: MemoryStore): MemoryStore {
  const proxy: MemoryStore = {
    inspector: inner.inspector,
    compaction: wrapCompaction(inner.compaction, (message) =>
      stripImageParts(stripReasoningParts(message)),
    ),
    load: async ({ scope }) => {
      const messages = await inner.load({ scope });
      return messages.map((message) => stripImageParts(stripReasoningParts(message)));
    },
    append: (input) => inner.append(input),
    clear: (input) => inner.clear(input),
  };
  if (inner.recordError) {
    proxy.recordError = (input) => inner.recordError!(input);
  }
  return proxy;
}

/**
 * Construct the strict v1 Prisma store and sanitize only at persistence/model
 * boundaries. PrismaMemoryStore owns append, errors, snapshots, and
 * Serializable atomic prefix replacement; this module owns no compaction log.
 */
export function createSanitizedMemoryStore(
  prisma: PrismaClient,
): SanitizedMemoryStore {
  const inner = new PrismaMemoryStore({
    client: prisma,
    errorPolicy: "store",
    validateMessages: true,
    scopeKey: ({ scope }) =>
      createDefaultMemoryScopeKey(scope.sessionId, scope.userId),
  });

  return {
    kind: inner.kind,
    inspector: inner.inspector,
    compaction: wrapCompaction(inner.compaction, stripReasoningParts),
    validate: () => inner.validate(),
    load: async ({ scope }) => {
      const messages = await inner.load({ scope });
      return messages
        .map((message) => stripReasoningParts(parseMessage(message)))
        .filter(
          (message) =>
            !(isRecord(message.metadata) && message.metadata.kind === "error"),
        );
    },
    append: (input) =>
      inner.append({
        ...input,
        messages: sanitizeMessages(input.messages),
      }),
    clear: (input) => inner.clear(input),
    recordError: async (input) => {
      if (!inner.recordError) return;
      await inner.recordError({
        ...input,
        messages: sanitizeMessages(input.messages),
      });
    },
  } as SanitizedMemoryStore;
}

export async function validateSanitizedMemoryStore(
  prisma: PrismaClient,
): Promise<void> {
  await createSanitizedMemoryStore(prisma).validate();
}
