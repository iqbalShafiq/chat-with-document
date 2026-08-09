import type { UIMessage } from "@anvia/react";

const STOPPED_TOOL_MESSAGE = "Stopped before this tool finished.";

/**
 * Mark in-flight tool parts as errored so the activity panel shows Error
 * instead of forever-"Working" after a mid-run stop or a history reload of
 * an incomplete tool_call (no matching tool_result in memory).
 *
 * `input-streaming` / `input-available` → `error`. Done / already-error parts
 * are left alone.
 */
export function finalizeInterruptedTools(
  messages: UIMessage[],
  reason: string = STOPPED_TOOL_MESSAGE,
): UIMessage[] {
  let anyChanged = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      if (part.state === "output-available" || part.state === "error") {
        return part;
      }
      messageChanged = true;
      return {
        ...part,
        state: "error" as const,
        error: { message: reason },
      };
    });
    if (!messageChanged) return message;
    anyChanged = true;
    return { ...message, parts };
  });
  return anyChanged ? next : messages;
}
