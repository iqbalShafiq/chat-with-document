import type { Message as MessageType } from "@anvia/core/completion";

/**
 * Keep text + metadata for the agent prompt. Drop document/file parts —
 * files are ingested into RAG and accessed via tools, not the completion API.
 * Vision models keep image parts so they can see pixels natively.
 */
export function stripUserAttachments(
  message: MessageType,
  options: { keepImages?: boolean } = {},
): MessageType {
  if (message.role !== "user") {
    return message;
  }

  // v1 permits a plain string user message. There are no attachments to
  // remove, and returning the original object preserves its metadata.
  if (typeof message.content === "string") {
    return message;
  }

  const kept = message.content.filter((content) => {
    if (content.type === "text") return true;
    return Boolean(options.keepImages) && content.type === "image";
  });

  const content =
    kept.length > 0 ? kept : [{ type: "text" as const, text: "" }];

  return { ...message, content } as MessageType;
}
