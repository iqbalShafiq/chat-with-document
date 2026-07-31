import type { UIMessage } from "@anvia/react";

export type ChatMessageMeta = {
  createdAt?: string;
  clientMessageId?: string;
  memoryPosition?: number;
  documentIds?: string[];
  sessionId?: string;
  attachedDocuments?: Array<{ name: string; mediaType?: string }>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readChatMessageMeta(
  metadata: UIMessage["metadata"],
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
  if (typeof metadata.sessionId === "string") {
    meta.sessionId = metadata.sessionId;
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

  return meta;
}

export function withChatMessageMeta(
  base: UIMessage["metadata"],
  patch: ChatMessageMeta,
): NonNullable<UIMessage["metadata"]> {
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
  if (patch.sessionId !== undefined) current.sessionId = patch.sessionId;
  if (patch.attachedDocuments !== undefined) {
    current.attachedDocuments = patch.attachedDocuments.map((doc) => {
      if (doc.mediaType === undefined) return { name: doc.name };
      return { name: doc.name, mediaType: doc.mediaType };
    });
  }

  return current as NonNullable<UIMessage["metadata"]>;
}

export function canTargetMessageForTruncate(meta: ChatMessageMeta): boolean {
  return (
    (typeof meta.memoryPosition === "number" && meta.memoryPosition >= 0) ||
    (typeof meta.clientMessageId === "string" &&
      meta.clientMessageId.length > 0)
  );
}
