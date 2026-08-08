import { DEFAULT_COMPLETION_MODEL, isKnownModel } from "#/lib/chat/models";
import type { ImageGenSettings, ModelInfo } from "#/lib/api";

export const SELECTED_MODEL_KEY = "chat.selectedModel";
export const SELECTED_REASONING_EFFORT_KEY = "chat.selectedReasoningEffort";
export const IMAGE_GEN_ENABLED_KEY = "chat.imageGenerationEnabled";
export const IMAGE_GEN_SETTINGS_KEY = "chat.imageGenSettings";

export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettings = {
  modelId: "openai/gpt-5-image-mini",
  aspectRatio: "1:1",
};

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

export function readImageGenerationEnabled(): boolean {
  try {
    return localStorage.getItem(IMAGE_GEN_ENABLED_KEY) === "1";
  } catch {
    // ignore storage access errors
    return false;
  }
}

export function persistImageGenerationEnabled(enabled: boolean) {
  try {
    if (enabled) {
      localStorage.setItem(IMAGE_GEN_ENABLED_KEY, "1");
    } else {
      localStorage.removeItem(IMAGE_GEN_ENABLED_KEY);
    }
  } catch {
    // ignore storage access errors
  }
}

/** Stored settings merged over the defaults; unknown keys are dropped. */
export function readImageGenSettings(): ImageGenSettings {
  const settings: ImageGenSettings = { ...DEFAULT_IMAGE_GEN_SETTINGS };
  try {
    const stored = localStorage.getItem(IMAGE_GEN_SETTINGS_KEY);
    if (stored === null) return settings;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return settings;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.modelId === "string" && record.modelId.length > 0) {
      settings.modelId = record.modelId;
    }
    if (typeof record.aspectRatio === "string" && record.aspectRatio.length > 0) {
      settings.aspectRatio = record.aspectRatio;
    }
    if (typeof record.quality === "string" && record.quality.length > 0) {
      settings.quality = record.quality;
    }
    if (typeof record.background === "string" && record.background.length > 0) {
      settings.background = record.background;
    }
    if (
      typeof record.n === "number" &&
      Number.isFinite(record.n) &&
      record.n >= 1
    ) {
      settings.n = Math.floor(record.n);
    }
  } catch {
    // ignore storage access errors
  }
  return settings;
}

export function persistImageGenSettings(settings: ImageGenSettings) {
  try {
    localStorage.setItem(IMAGE_GEN_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage access errors
  }
}
