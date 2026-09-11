import { createContext, useContext } from "react";
import type { ToolWaitProgress } from "#/lib/chat/client-data";

export const HIDDEN_CONTROL_TOOL_NAMES = new Set([
  "await_tool_call",
  "cancel_tool_call",
]);

export function reduceToolWaitProgress(
  state: Readonly<Record<string, ToolWaitProgress>>,
  event: ToolWaitProgress,
): Record<string, ToolWaitProgress> {
  return { ...state, [event.toolCallId]: event };
}

export function isStillRunningToolOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as { status?: unknown; value?: unknown };
  if (record.status === "still_running") return true;
  if (typeof record.value === "object" && record.value !== null) {
    return (record.value as { status?: unknown }).status === "still_running";
  }
  return false;
}

export function isCancelledToolOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as { status?: unknown; value?: unknown };
  if (record.status === "cancelled") return true;
  if (typeof record.value === "object" && record.value !== null) {
    return (record.value as { status?: unknown }).status === "cancelled";
  }
  return false;
}

const ToolWaitProgressContext = createContext<Readonly<Record<string, ToolWaitProgress>>>({});

export const ToolWaitProgressProvider = ToolWaitProgressContext.Provider;

export function useToolWaitProgress(toolCallId: string | undefined): ToolWaitProgress | undefined {
  const state = useContext(ToolWaitProgressContext);
  if (!toolCallId) return undefined;
  return state[toolCallId];
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
