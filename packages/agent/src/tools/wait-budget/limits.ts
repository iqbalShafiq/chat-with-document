import { AWAIT_TOOL_CALL_NAME, CANCEL_TOOL_CALL_NAME } from "./types.js";

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Optional global slice override (used in local/real-LLM checks). */
const SLICE_OVERRIDE_MS = envMs("TOOL_WAIT_SLICE_MS", 0);

export const DEFAULT_WAIT_SLICE_MS = envMs("TOOL_WAIT_DEFAULT_SLICE_MS", 12_000);
export const IMAGE_WAIT_SLICE_MS = envMs("TOOL_WAIT_IMAGE_SLICE_MS", 30_000);
export const DEEP_RESEARCH_WAIT_SLICE_MS = envMs("TOOL_WAIT_DEEP_RESEARCH_SLICE_MS", 30_000);
export const MAX_JOB_WALL_MS = 5 * 60_000;
export const R2_TIMEOUT_MS = 20_000;
export const SQL_TIMEOUT_MS = 15_000;

export function waitBudgetForTool(toolName: string): number {
  if (toolName === AWAIT_TOOL_CALL_NAME || toolName === CANCEL_TOOL_CALL_NAME) {
    throw new Error(`${toolName} must not be wrapped with a wait budget.`);
  }
  if (SLICE_OVERRIDE_MS > 0) return SLICE_OVERRIDE_MS;
  if (toolName === "generate_image" || toolName === "edit_image") return IMAGE_WAIT_SLICE_MS;
  if (toolName === "deep_research") return DEEP_RESEARCH_WAIT_SLICE_MS;
  return DEFAULT_WAIT_SLICE_MS;
}
