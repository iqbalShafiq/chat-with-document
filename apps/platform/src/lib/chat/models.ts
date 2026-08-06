/**
 * Model registry helpers backed by the API-driven catalog (`listModels`).
 * Model ids come from the server DB, not a client allow-list.
 */

import type { ModelInfo, ReasoningEffortInfo } from "#/lib/api";

export const DEFAULT_COMPLETION_MODEL = "gpt-5.6-luna";
export type ReasoningEffort = string;

export function isKnownModel(models: ModelInfo[], modelId: string): boolean {
  return models.some((model) => model.modelId === modelId);
}

export function modelById(
  models: ModelInfo[],
  modelId: string,
): ModelInfo | null {
  return models.find((model) => model.modelId === modelId) ?? null;
}

/** @deprecated — single-arg form kept for legacy callers; remove in Task 13. */
export function modelLabel(modelId: string): string;
export function modelLabel(models: ModelInfo[], modelId: string): string;
export function modelLabel(
  models: ModelInfo[] | string,
  modelId?: string,
): string {
  if (typeof models === "string") {
    return MODEL_OPTIONS.find((m) => m.id === models)?.label ?? models;
  }
  return modelById(models, modelId ?? "")?.label ?? (modelId ?? "");
}

/** @deprecated — single-arg form kept for legacy callers; remove in Task 13. */
export function reasoningLabel(effort: string): string;
export function reasoningLabel(
  efforts: ReasoningEffortInfo[],
  key: string | null,
): string;
export function reasoningLabel(
  efforts: ReasoningEffortInfo[] | string,
  key?: string | null,
): string {
  if (typeof efforts === "string") {
    return (
      REASONING_OPTIONS.find((r) => r.id === efforts)?.label ??
      efforts.charAt(0).toUpperCase() + efforts.slice(1)
    );
  }
  if (key === null) return "None";
  return efforts.find((effort) => effort.key === key)?.label ?? (key ?? "");
}

/**
 * Fallback when switching to a model that does not support the current effort:
 * prefer the level directly below, then the one directly above, then null.
 */
export function resolveReasoningFallback(
  effort: string | null,
  supported: string[],
  allEfforts: ReasoningEffortInfo[],
): string | null {
  if (effort === null) return null;
  if (supported.includes(effort)) return effort;
  if (supported.length === 0) return null;
  const ordered = [...allEfforts].sort((a, b) => a.sortOrder - b.sortOrder);
  const currentIndex = ordered.findIndex((entry) => entry.key === effort);
  const sortedSupported = [...supported].sort(
    (a, b) =>
      ordered.findIndex((e) => e.key === a) -
      ordered.findIndex((e) => e.key === b),
  );
  if (currentIndex !== -1) {
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      if (sortedSupported.includes(ordered[i]!.key)) return ordered[i]!.key;
    }
    for (let i = currentIndex + 1; i < ordered.length; i += 1) {
      if (sortedSupported.includes(ordered[i]!.key)) return ordered[i]!.key;
    }
  }
  return sortedSupported[0] ?? null;
}

// ─── Deprecated legacy exports — remove in Task 13 ──────────────────────────
// Kept so the switcher / settings modal keep compiling until Task 13 rewires
// them onto the API catalog.

/** @deprecated — remove in Task 13; use `string` directly. */
export type CompletionModelId = string;

/** @deprecated — remove in Task 13. */
export type ModelOption = {
  id: string;
  label: string;
  /** Short subtitle for menus (tier / relative cost). */
  hint: string;
};

/** @deprecated — remove in Task 13; use `listModels()`. */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: "gpt-5.6-luna", label: "Luna", hint: "Fastest · lowest cost" },
  { id: "gpt-5.6-terra", label: "Terra", hint: "Balanced" },
  { id: "gpt-5.6-sol", label: "Sol", hint: "Highest quality" },
];

/** @deprecated — remove in Task 13. */
export type ReasoningOption = {
  id: string;
  label: string;
};

/** @deprecated — remove in Task 13; use `listModels()`. */
export const REASONING_OPTIONS: ReasoningOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/** @deprecated — remove in Task 13. */
export const COMPLETION_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

/** @deprecated — remove in Task 13. */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

/** @deprecated — remove in Task 13. */
export const DEFAULT_REASONING_EFFORT = "medium";

/** @deprecated — remove in Task 13; single-arg form kept for legacy callers. */
export function isCompletionModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (COMPLETION_MODELS as readonly string[]).includes(value)
  );
}

/** @deprecated — remove in Task 13. */
export function isReasoningEffort(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}
