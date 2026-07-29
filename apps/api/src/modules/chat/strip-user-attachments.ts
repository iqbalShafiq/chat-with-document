import { Message, UserContent, type Message as MessageType } from "@anvia/core/completion";

/**
 * Keep text + metadata for the agent prompt. Drop document/image parts —
 * files are ingested into RAG and accessed via tools, not the completion API.
 */
export function stripUserAttachments(message: MessageType): MessageType {
  if (message.role !== "user") {
    return message;
  }

  const textParts = message.content.filter(
    (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
      content.type === "text",
  );

  const content =
    textParts.length > 0 ? textParts : [UserContent.text("")];

  return Message.user(content, {
    metadata: message.metadata,
  });
}
