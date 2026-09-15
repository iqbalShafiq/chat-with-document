import { AWAIT_TOOL_CALL_NAME, CANCEL_TOOL_CALL_NAME } from "./types.js";

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Optional global slice override (used in local/real-LLM checks). */
const SLICE_OVERRIDE_MS = envMs("TOOL_WAIT_SLICE_MS", 0);

/**
 * Starting observe slice for every tool. Deliberately uniform: how long a call
 * will take is not knowable from its name, and guessing it from a name list is
 * the kind of hardcoded classification this budget is meant to avoid.
 */
export const BASE_WAIT_SLICE_MS = envMs("TOOL_WAIT_BASE_SLICE_MS", 15_000);
/** Upper bound for one observe slice once escalation has run its course. */
export const MAX_WAIT_SLICE_MS = envMs("TOOL_WAIT_MAX_SLICE_MS", 120_000);
/**
 * Wall-clock ceiling for a single in-flight tool job. Long tools (research,
 * generation, large ingest) legitimately outlive a short slice, so this stays
 * well above every per-tool budget instead of cutting healthy work short.
 */
export const MAX_JOB_WALL_MS = envMs("TOOL_WAIT_MAX_WALL_MS", 30 * 60_000);
export const R2_TIMEOUT_MS = 20_000;
export const SQL_TIMEOUT_MS = 15_000;

/** Base slice before escalation; independent of tool identity. */
export function waitBudgetForTool(toolName: string): number {
  if (toolName === AWAIT_TOOL_CALL_NAME || toolName === CANCEL_TOOL_CALL_NAME) {
    throw new Error(`${toolName} must not be wrapped with a wait budget.`);
  }
  if (SLICE_OVERRIDE_MS > 0) return SLICE_OVERRIDE_MS;
  return BASE_WAIT_SLICE_MS;
}

/**
 * Grow the observe slice with every elapsed wait, for every tool and every
 * stage. Waiting is what consumes agent turns, so a fixed slice makes a long
 * tool burn its turn budget on polling and fail with max-turns instead of
 * finishing. Escalating on measured elapsed time (not on the tool's name)
 * means a slow call converges to a few long waits while a short one is
 * unaffected, and no tool needs a hand-tuned special case.
 */
export function escalateWaitSlice(baseSliceMs: number, elapsedWaitCount: number): number {
  const step = Number.isFinite(elapsedWaitCount) && elapsedWaitCount > 0
    ? Math.floor(elapsedWaitCount)
    : 0;
  const base = Math.max(1, baseSliceMs);
  if (step === 0) return base;
  const ceiling = Math.max(base, MAX_WAIT_SLICE_MS);
  // Cap the shift so a very long job cannot overflow into a broken budget.
  const grown = base * 2 ** Math.min(step, 16);
  return Math.min(grown, ceiling);
}
