import type { Message as MessageType } from "@anvia/core/completion";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAssistantMessage(
  message: MessageType,
  validToolCallIds: Set<string>,
): MessageType | null {
  if (message.role !== "assistant") return message;

  const hasReasoningWithId = message.content.some(
    (content) =>
      content.type === "reasoning" &&
      typeof content.id === "string" &&
      content.id.length > 0,
  );

  if (!hasReasoningWithId) {
    const filteredContent = message.content.filter(
      (content) => content.type !== "tool_call",
    );
    if (filteredContent.length === 0) return null;
    return { ...message, content: filteredContent };
  }

  for (const content of message.content) {
    if (content.type !== "tool_call") continue;
    const callId =
      typeof content.callId === "string" && content.callId.length > 0
        ? content.callId
        : content.id;
    validToolCallIds.add(callId);
  }

  return message;
}

function sanitizeToolMessage(
  message: MessageType,
  validToolCallIds: Set<string>,
): MessageType | null {
  if (message.role !== "tool") return message;

  const filteredContent = message.content.filter((content) => {
    const callId =
      typeof content.callId === "string" && content.callId.length > 0
        ? content.callId
        : content.id;
    return validToolCallIds.has(callId);
  });

  if (filteredContent.length === 0) return null;
  return { ...message, content: filteredContent };
}

export function sanitizeMemoryMessages(messages: MessageType[]): MessageType[] {
  const validToolCallIds = new Set<string>();
  const sanitized: MessageType[] = [];

  for (const message of messages) {
    if (!isObject(message) || !Array.isArray((message as { content?: unknown }).content)) {
      continue;
    }

    const afterAssistant = sanitizeAssistantMessage(message, validToolCallIds);
    if (!afterAssistant) continue;

    const afterTool = sanitizeToolMessage(afterAssistant, validToolCallIds);
    if (!afterTool) continue;

    sanitized.push(afterTool);
  }

  return sanitized;
}
