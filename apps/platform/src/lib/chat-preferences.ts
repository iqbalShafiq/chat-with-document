import { DEFAULT_COMPLETION_MODEL, isKnownModel } from "#/lib/chat/models";
import type { ModelInfo } from "#/lib/api";

export const SELECTED_MODEL_KEY = "chat.selectedModel";
export const SELECTED_REASONING_EFFORT_KEY = "chat.selectedReasoningEffort";

/**
 * Stored model id if it exists in the catalog, else the first active model,
 * else the default.
 */
export function readSelectedModel(models: ModelInfo[]): string {
  try {
    const stored = localStorage.getItem(SELECTED_MODEL_KEY);
    if (stored !== null && stored.length > 0 && isKnownModel(models, stored)) {
      return stored;
    }
  } catch {
    // ignore storage access errors
  }
  return models[0]?.modelId ?? DEFAULT_COMPLETION_MODEL;
}

export function persistSelectedModel(model: string) {
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, model);
  } catch {
    // ignore storage access errors
  }
}

/**
 * Stored key when it is supported by the current model, the stored key
 * as-is when unsupported (so `resolveReasoningFallback` can map it), null
 * when nothing is stored or the model supports no efforts.
 */
export function readSelectedReasoningEffort(effortKeys: string[]): string | null {
  try {
    const stored = localStorage.getItem(SELECTED_REASONING_EFFORT_KEY);
    if (stored === null || stored.length === 0) return null;
    if (effortKeys.includes(stored)) return stored;
    if (effortKeys.length === 0) return null;
    return stored;
  } catch {
    // ignore storage access errors
    return null;
  }
}

export function persistSelectedReasoningEffort(effort: string | null) {
  try {
    if (effort === null) {
      localStorage.removeItem(SELECTED_REASONING_EFFORT_KEY);
    } else {
      localStorage.setItem(SELECTED_REASONING_EFFORT_KEY, effort);
    }
  } catch {
    // ignore storage access errors
  }
}
