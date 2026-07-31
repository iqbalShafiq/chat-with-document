import type { UIMessage } from "@anvia/react";

/** Raw text/markdown from message text parts (matches Anvia Message.Copy source). */
export function getMessageRawText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

export function messageHasUserFacingText(message: UIMessage): boolean {
  return getMessageRawText(message).trim().length > 0;
}
