export type ClarificationResponseBody = {
  answers: Record<string, string | string[]>;
  skipped: string[];
};

/** Per-answer text bound (mirrors the agent's question text bound). */
const MAX_ANSWER_LENGTH = 2000;
/** Max items in an array answer (mirrors multiple_choice option bound). */
const MAX_ANSWER_ARRAY_ITEMS = 8;
/** Max distinct answer keys. */
const MAX_ANSWER_KEYS = 10;
/** Max skipped question ids. */
const MAX_SKIPPED_ITEMS = 10;
/** Per-skipped-id length bound. */
const MAX_SKIPPED_LENGTH = 100;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate the POST body of the clarification response route: an answers
 * object of string | string[] values and an optional skipped string array,
 * all within bounded sizes. Null when the shape is invalid (the route
 * replies 400).
 */
export function parseClarificationResponseBody(
  value: unknown,
): ClarificationResponseBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !record.answers ||
    typeof record.answers !== "object" ||
    Array.isArray(record.answers)
  ) {
    return null;
  }
  const answers: Record<string, string | string[]> = {};
  for (const [key, answer] of Object.entries(record.answers)) {
    if (Object.keys(answers).length >= MAX_ANSWER_KEYS) return null;
    if (typeof answer === "string") {
      if (answer.length > MAX_ANSWER_LENGTH) return null;
      answers[key] = answer;
    } else if (isStringArray(answer)) {
      if (answer.length > MAX_ANSWER_ARRAY_ITEMS) return null;
      if (answer.some((item) => item.length > MAX_ANSWER_LENGTH)) return null;
      answers[key] = answer;
    } else {
      return null;
    }
  }
  if (record.skipped !== undefined) {
    if (!isStringArray(record.skipped)) return null;
    if (record.skipped.length > MAX_SKIPPED_ITEMS) return null;
    if (record.skipped.some((item) => item.length > MAX_SKIPPED_LENGTH)) {
      return null;
    }
  }
  return { answers, skipped: record.skipped ?? [] };
}
