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

export function modelLabel(models: ModelInfo[], modelId: string): string {
  return modelById(models, modelId)?.label ?? modelId;
}

export function reasoningLabel(
  efforts: ReasoningEffortInfo[],
  key: string | null,
): string {
  if (key === null) return "None";
  return efforts.find((effort) => effort.key === key)?.label ?? key;
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

