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

export type GenerationActionInfo = {
  /** True when this assistant message is the LAST message of its generation. */
  isGenerationEnd: boolean;
  /** Combined raw text of every assistant message in the same generation. */
  generationText: string;
};

/**
 * A "generation" is one user turn and everything the assistant produced for
 * it: reasoning, tool calls, and possibly several assistant text messages
 * (reply → tool → thinking → reply again). The generation ends at the next
 * user message (or the end of the list).
 *
 * Returns per-assistant-message info so the UI can show the copy/timestamp
 * footer only on the final assistant message of each generation and copy the
 * whole generation's text when clicked.
 */
export function computeGenerationActionInfo(
  messages: UIMessage[],
): Map<string, GenerationActionInfo> {
  const info = new Map<string, GenerationActionInfo>();

  let generationStart = 0;
  for (let index = 0; index <= messages.length; index++) {
    const isUserBoundary =
      index < messages.length && messages[index]!.role === "user";
    if (!isUserBoundary && index < messages.length) continue;

    const generation = messages.slice(generationStart, index);
    let lastAssistantIndex = -1;
    for (let i = 0; i < generation.length; i++) {
      if (generation[i]!.role === "assistant") lastAssistantIndex = i;
    }
    const generationText = generation
      .filter((message) => message.role === "assistant")
      .map(getMessageRawText)
      .filter((text) => text.trim().length > 0)
      .join("\n\n");

    for (let i = 0; i < generation.length; i++) {
      const message = generation[i]!;
      if (message.role !== "assistant") continue;
      info.set(message.id, {
        isGenerationEnd: i === lastAssistantIndex,
        generationText,
      });
    }

    generationStart = index + 1;
  }

  return info;
}
