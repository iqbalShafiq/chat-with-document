import {
  DEFAULT_COMPLETION_MODEL,
  DEFAULT_REASONING_EFFORT,
  isCompletionModelId,
  isReasoningEffort,
  type CompletionModelId,
  type ReasoningEffort,
} from "#/lib/chat/models";

export const SELECTED_MODEL_KEY = "chat.selectedModel";
export const SELECTED_REASONING_EFFORT_KEY = "chat.selectedReasoningEffort";

export function readSelectedModel(): CompletionModelId {
  try {
    const stored = localStorage.getItem(SELECTED_MODEL_KEY);
    if (isCompletionModelId(stored)) return stored;
  } catch {
    // ignore storage access errors
  }
  return DEFAULT_COMPLETION_MODEL;
}

export function persistSelectedModel(model: CompletionModelId) {
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, model);
  } catch {
    // ignore storage access errors
  }
}

export function readSelectedReasoningEffort(): ReasoningEffort {
  try {
    const stored = localStorage.getItem(SELECTED_REASONING_EFFORT_KEY);
    if (isReasoningEffort(stored)) return stored;
  } catch {
    // ignore storage access errors
  }
  return DEFAULT_REASONING_EFFORT;
}

export function persistSelectedReasoningEffort(effort: ReasoningEffort) {
  try {
    localStorage.setItem(SELECTED_REASONING_EFFORT_KEY, effort);
  } catch {
    // ignore storage access errors
  }
}
