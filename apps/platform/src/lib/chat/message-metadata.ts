import type { UIMessage } from "@anvia/client";
import type { ContextSnippetSourceRole } from "#/lib/chat/context-snippet-text";
import type { MessageCitation } from "#/lib/chat/citations";
import { parseCitationsFromMetadata } from "#/lib/chat/citations";

export type ChatMessageMeta = {
  createdAt?: string;
  clientMessageId?: string;
  memoryPosition?: number;
  documentIds?: string[];
  attachedDocuments?: Array<{ name: string; mediaType?: string }>;
  /** Single pinned context snippet carried by a sent user message. */
  contextSnippet?: { text: string; sourceRole: ContextSnippetSourceRole };
  /** Dual-written structured citations (server and/or client). */
  citations?: MessageCitation[];
  /** UI classification: failed run, or summary derived only from the native marker. */
  kind?: "summary" | "error";
  /** Canonical Anvia v1 memory-summary marker; never synthesized by the UI. */
  anvia?: {
    memoryCompaction: {
      version: 1;
      compactedMessageCount: number;
    };
  };
};

/** Fields that callers may write. A summary is derived from Anvia's native marker. */
export type ChatMessageMetaPatch = Omit<ChatMessageMeta, "kind"> & {
  kind?: "error";
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readChatMessageMeta(
  metadata: unknown,
): ChatMessageMeta {
  if (!isPlainObject(metadata)) return {};

  const meta: ChatMessageMeta = {};

  if (typeof metadata.createdAt === "string") {
    meta.createdAt = metadata.createdAt;
  }
  if (typeof metadata.clientMessageId === "string") {
    meta.clientMessageId = metadata.clientMessageId;
  }
  if (
    typeof metadata.memoryPosition === "number" &&
    Number.isInteger(metadata.memoryPosition)
  ) {
    meta.memoryPosition = metadata.memoryPosition;
  }
  if (Array.isArray(metadata.documentIds)) {
    meta.documentIds = metadata.documentIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  if (Array.isArray(metadata.attachedDocuments)) {
    meta.attachedDocuments = metadata.attachedDocuments.flatMap((item) => {
      if (!isPlainObject(item) || typeof item.name !== "string") return [];
      return typeof item.mediaType === "string"
        ? [{ name: item.name, mediaType: item.mediaType }]
        : [{ name: item.name }];
    });
  }

  const contextSnippet = metadata.contextSnippet;
  if (
    isPlainObject(contextSnippet) &&
    typeof contextSnippet.text === "string" &&
    (contextSnippet.sourceRole === "user" ||
      contextSnippet.sourceRole === "assistant")
  ) {
    meta.contextSnippet = {
      text: contextSnippet.text,
      sourceRole: contextSnippet.sourceRole,
    };
  }

  const anvia = metadata.anvia;
  const memoryCompaction =
    isPlainObject(anvia) && isPlainObject(anvia.memoryCompaction)
      ? anvia.memoryCompaction
      : null;
  if (
    memoryCompaction?.version === 1 &&
    typeof memoryCompaction.compactedMessageCount === "number" &&
    Number.isSafeInteger(memoryCompaction.compactedMessageCount) &&
    memoryCompaction.compactedMessageCount > 0
  ) {
    meta.anvia = {
      memoryCompaction: {
        version: 1,
        compactedMessageCount: memoryCompaction.compactedMessageCount,
      },
    };
    meta.kind = "summary";
  } else if (metadata.kind === "error") {
    meta.kind = "error";
  }

  const citations = parseCitationsFromMetadata(metadata);
  if (citations !== null) {
    meta.citations = citations;
  }

  return meta;
}

export function withChatMessageMeta(
  base: UIMessage["metadata"],
  patch: ChatMessageMetaPatch,
): ChatMessageMeta {
  const current: Record<string, unknown> = isPlainObject(base)
    ? { ...base }
    : {};

  if (patch.createdAt !== undefined) current.createdAt = patch.createdAt;
  if (patch.clientMessageId !== undefined) {
    current.clientMessageId = patch.clientMessageId;
  }
  if (patch.memoryPosition !== undefined) {
    current.memoryPosition = patch.memoryPosition;
  }
  if (patch.documentIds !== undefined) current.documentIds = patch.documentIds;
  if (patch.attachedDocuments !== undefined) {
    current.attachedDocuments = patch.attachedDocuments.map((doc) => {
      if (doc.mediaType === undefined) return { name: doc.name };
      return { name: doc.name, mediaType: doc.mediaType };
    });
  }
  if (patch.contextSnippet !== undefined) {
    current.contextSnippet = {
      text: patch.contextSnippet.text,
      sourceRole: patch.contextSnippet.sourceRole,
    };
  }
  if (patch.citations !== undefined) {
    current.citations = patch.citations.map((c) => {
      const row: Record<string, string | number | boolean> = {
        id: c.id,
        filename: c.filename,
      };
      if (c.documentId !== undefined) row.documentId = c.documentId;
      if (c.pageIndex !== undefined) row.pageIndex = c.pageIndex;
      if (c.pageId !== undefined) row.pageId = c.pageId;
      if (c.chunkId !== undefined) row.chunkId = c.chunkId;
      if (c.snippet !== undefined) row.snippet = c.snippet;
      if (c.inSession !== undefined) row.inSession = c.inSession;
      return row;
    });
  }
  if (patch.anvia !== undefined) {
    current.anvia = {
      memoryCompaction: { ...patch.anvia.memoryCompaction },
    };
  }
  if (patch.kind === "error") current.kind = patch.kind;
  // Never carry a legacy summary classification across a write. Native
  // compaction metadata is the sole source of truth for summary messages.
  if (current.kind === "summary" && !isPlainObject(current.anvia)) {
    delete current.kind;
  }

  return current as ChatMessageMeta;
}

export function canTargetMessageForTruncate(meta: ChatMessageMeta): boolean {
  return (
    (typeof meta.memoryPosition === "number" && meta.memoryPosition >= 0) ||
    (typeof meta.clientMessageId === "string" &&
      meta.clientMessageId.length > 0)
  );
}
