/**
 * Client allow-list for chat model / reasoning switchers.
 * Keep ids in sync with packages/agent/src/providers/openai.ts.
 */

export const COMPLETION_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

export type CompletionModelId = (typeof COMPLETION_MODELS)[number];

export const DEFAULT_COMPLETION_MODEL: CompletionModelId = "gpt-5.6-luna";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export type ModelOption = {
  id: CompletionModelId;
  label: string;
  /** Short subtitle for menus (tier / relative cost). */
  hint: string;
};

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "gpt-5.6-luna", label: "Luna", hint: "Fastest · lowest cost" },
  { id: "gpt-5.6-terra", label: "Terra", hint: "Balanced" },
  { id: "gpt-5.6-sol", label: "Sol", hint: "Highest quality" },
];

export type ReasoningOption = {
  id: ReasoningEffort;
  label: string;
};

export const REASONING_OPTIONS: ReasoningOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

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

export function modelLabel(modelId: string): string {
  return MODEL_OPTIONS.find((m) => m.id === modelId)?.label ?? modelId;
}

export function reasoningLabel(effort: string): string {
  return (
    REASONING_OPTIONS.find((r) => r.id === effort)?.label ??
    effort.charAt(0).toUpperCase() + effort.slice(1)
  );
}
