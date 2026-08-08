export type ClarificationResponseBody = {
  answers: Record<string, string | string[]>;
  skipped: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate the POST body of the clarification response route: an answers
 * object of string | string[] values and an optional skipped string array.
 * Null when the shape is invalid (the route replies 400).
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
    if (typeof answer === "string") {
      answers[key] = answer;
    } else if (isStringArray(answer)) {
      answers[key] = answer;
    } else {
      return null;
    }
  }
  if (record.skipped !== undefined && !isStringArray(record.skipped)) {
    return null;
  }
  return { answers, skipped: record.skipped ?? [] };
}
