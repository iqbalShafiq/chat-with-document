import type { StreamingCompletionModel } from "@anvia/core/completion";
import { OpenAIClient } from "@anvia/openai";

/** Model ids are registered in the DB registry; any non-empty id is structurally valid. */
export type CompletionModelId = string;

export const DEFAULT_COMPLETION_MODEL: CompletionModelId = "openai/gpt-5.6-luna";
export const DEFAULT_COMPLETION_PROVIDER = "openai";

export const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function isCompletionModelId(value: unknown): value is CompletionModelId {
  return typeof value === "string" && value.trim().length > 0;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

export function parseCompletionModel(value: unknown): CompletionModelId | null {
  return isCompletionModelId(value) ? value : null;
}

/** Returns null when value is missing or not in the allow-list. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return isReasoningEffort(value) ? value : null;
}

let openai: OpenAIClient | null = null;

function getOpenAIClient(): OpenAIClient {
  openai ??= new OpenAIClient({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    ...(process.env.OPENAI_BASE_URL
      ? { baseUrl: process.env.OPENAI_BASE_URL }
      : {}),
  });
  return openai;
}

export function createCompletionModel(
  modelId: CompletionModelId = DEFAULT_COMPLETION_MODEL,
): StreamingCompletionModel {
  return getOpenAIClient().completionModel({ modelId, api: "responses" });
}

/** Strict OpenAI Responses options supplied at Agent construction time. */
export function providerOptionsForReasoning(
  effort: ReasoningEffort,
): { reasoning: { effort: ReasoningEffort; summary: "auto" } } {
  return {
    reasoning: { effort, summary: "auto" },
  };
}

let defaultModelValue: StreamingCompletionModel | null = null;

export function defaultModel(): StreamingCompletionModel {
  defaultModelValue ??= createCompletionModel(DEFAULT_COMPLETION_MODEL);
  return defaultModelValue;
}
