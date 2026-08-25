import { readChatMessageMeta } from "#/lib/chat/message-metadata";

export type FailedTailMessage = {
  role: string;
  metadata?: unknown;
};

export type FailedTailTruncate = {
  clientMessageId: string;
  expectedPrefixMessageCount: number;
};

function metadataKind(metadata: unknown): string | undefined {
  const kind = readChatMessageMeta(metadata).kind;
  return kind;
}

/**
 * A persisted [user, assistant kind:"error"] tail must be truncated before a
 * retry prompt is sent. Returns null when the live conversation is not in
 * that state.
 */
export function failedTailTruncate(
  messages: readonly FailedTailMessage[],
): FailedTailTruncate | null {
  const last = messages.at(-1);
  const secondLast = messages.at(-2);
  if (last?.role !== "assistant" || secondLast?.role !== "user") return null;
  if (metadataKind(last.metadata) !== "error") return null;
  const clientMessageId = readChatMessageMeta(secondLast.metadata).clientMessageId;
  if (!clientMessageId) return null;
  return {
    clientMessageId,
    expectedPrefixMessageCount: messages
      .slice(0, -2)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .length,
  };
}
