import type { CompletionModel } from "@anvia/core";
import { OpenAIClient } from "@anvia/openai";

/** Cheap → expensive. Keep in sync with platform UI allow-list. */
export const COMPLETION_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

export type CompletionModelId = (typeof COMPLETION_MODELS)[number];

export const DEFAULT_COMPLETION_MODEL: CompletionModelId = "gpt-5.6-luna";
export const DEFAULT_COMPLETION_PROVIDER = "openai";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function isCompletionModelId(value: unknown): value is CompletionModelId {
  return (
    typeof value === "string" &&
    (COMPLETION_MODELS as readonly string[]).includes(value)
  );
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/** Returns null when value is missing or not in the allow-list. */
export function parseCompletionModel(value: unknown): CompletionModelId | null {
  return isCompletionModelId(value) ? value : null;
}

/** Returns null when value is missing or not in the allow-list. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return isReasoningEffort(value) ? value : null;
}

const openai = new OpenAIClient({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  completionApi: "responses",
});

export function createCompletionModel(
  modelId: CompletionModelId = DEFAULT_COMPLETION_MODEL,
): CompletionModel {
  // GPT-5.6 Luna/Terra/Sol are not all in Anvia's known-name union yet.
  return openai.completionModel(modelId) as CompletionModel;
}

export const defaultModel = createCompletionModel(DEFAULT_COMPLETION_MODEL);
