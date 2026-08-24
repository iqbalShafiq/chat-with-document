/** OpenAI-aligned heuristic: ~4 characters per token (Microsoft Agent Framework default). */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IMAGE_TOKENS = 85;

function countPart(part: unknown): number {
  if (!isRecord(part)) return 0;
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      return estimateTextTokens(text);
    }
    case "image":
    case "input_image":
    case "output_image":
      return IMAGE_TOKENS;
    case "tool-result": {
      const output = part.output;
      if (!isRecord(output)) return 0;
      if (output.type === "text" || output.type === "error-text") {
        return typeof output.value === "string"
          ? estimateTextTokens(output.value)
          : 0;
      }
      if (output.type === "json" || output.type === "error-json") {
        try {
          return estimateTextTokens(JSON.stringify(output.value));
        } catch {
          return 0;
        }
      }
      if (output.type === "execution-denied") {
        return estimateTextTokens(
          typeof output.reason === "string" ? output.reason : "",
        );
      }
      if (output.type === "content" && Array.isArray(output.value)) {
        return output.value.reduce(
          (total, item) => total + countPart(item),
          0,
        );
      }
      return 0;
    }
    default: {
      try {
        return estimateTextTokens(JSON.stringify(part));
      } catch {
        return 0;
      }
    }
  }
}

export function estimateMessageTokens(message: unknown): number {
  if (!isRecord(message)) return 0;
  const overhead = 4; // role + separators
  let contentTokens = 0;
  if (typeof message.content === "string") {
    contentTokens = estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) contentTokens += countPart(part);
  }
  return overhead + contentTokens;
}

export function estimateMessagesTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}
