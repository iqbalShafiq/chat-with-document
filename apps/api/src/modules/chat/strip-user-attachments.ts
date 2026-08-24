import type { Message as MessageType } from "@anvia/core/completion";

/**
 * Keep text + metadata for the agent prompt. Drop document/image parts —
 * files are ingested into RAG and accessed via tools, not the completion API.
 */
export function stripUserAttachments(message: MessageType): MessageType {
  if (message.role !== "user") {
    return message;
  }

  // v1 permits a plain string user message. There are no attachments to
  // remove, and returning the original object preserves its metadata.
  if (typeof message.content === "string") {
    return message;
  }

  const textParts = message.content.filter(
    (content) => content.type === "text",
  );

  const content =
    textParts.length > 0 ? textParts : [{ type: "text" as const, text: "" }];

  return { ...message, content } as MessageType;
}
