import { AWAIT_TOOL_CALL_NAME, CANCEL_TOOL_CALL_NAME } from "./types.js";

export const DEFAULT_WAIT_SLICE_MS = 12_000;
export const IMAGE_WAIT_SLICE_MS = 30_000;
export const DEEP_RESEARCH_WAIT_SLICE_MS = 30_000;
export const MAX_JOB_WALL_MS = 5 * 60_000;
export const R2_TIMEOUT_MS = 20_000;
export const SQL_TIMEOUT_MS = 15_000;

export function waitBudgetForTool(toolName: string): number {
  if (toolName === AWAIT_TOOL_CALL_NAME || toolName === CANCEL_TOOL_CALL_NAME) {
    throw new Error(`${toolName} must not be wrapped with a wait budget.`);
  }
  if (toolName === "generate_image" || toolName === "edit_image") return IMAGE_WAIT_SLICE_MS;
  if (toolName === "deep_research") return DEEP_RESEARCH_WAIT_SLICE_MS;
  return DEFAULT_WAIT_SLICE_MS;
}
