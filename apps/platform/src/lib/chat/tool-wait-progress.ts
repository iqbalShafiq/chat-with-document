import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ToolWaitProgress } from "#/lib/chat/client-data";

export const HIDDEN_CONTROL_TOOL_NAMES = new Set([
  "await_tool_call",
  "cancel_tool_call",
]);

export function reduceToolWaitProgress(
  state: Readonly<Record<string, ToolWaitProgress>>,
  event: ToolWaitProgress,
): Record<string, ToolWaitProgress> {
  const previous = state[event.toolCallId];
  // "running" starts a fresh call, so its elapsed replaces any older value.
  // Every other phase reports progress within the same call, and the
  // "awaiting" phase intentionally reports 0 while a new slice starts; keep
  // the high-water mark so the wait shown to the user never goes backwards.
  const elapsedMs =
    previous === undefined || event.phase === "running"
      ? event.elapsedMs
      : Math.max(previous.elapsedMs, event.elapsedMs);
  return { ...state, [event.toolCallId]: { ...event, elapsedMs } };
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

const WAIT_TICK_MS = 1_000;

/**
 * Elapsed wait for an in-flight call, ticked locally.
 *
 * Progress events only arrive once per wait slice, and slices grow with the
 * elapsed wait (up to `TOOL_WAIT_MAX_SLICE_MS`), so a server-reported elapsed
 * value can look frozen for minutes. Anchoring to the last reported value and
 * counting forward keeps the label honest between events; it never runs past
 * the moment the call stopped waiting.
 */
export function useLiveWaitElapsed(
  baseElapsedMs: number | undefined,
  isWaiting: boolean,
): number | undefined {
  const anchorRef = useRef({ elapsedMs: baseElapsedMs ?? 0, at: Date.now() });
  const [tick, setTick] = useState(0);

  if (baseElapsedMs !== undefined && anchorRef.current.elapsedMs !== baseElapsedMs) {
    anchorRef.current = { elapsedMs: baseElapsedMs, at: Date.now() };
  }

  useEffect(() => {
    if (!isWaiting || baseElapsedMs === undefined) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), WAIT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isWaiting, baseElapsedMs]);

  if (baseElapsedMs === undefined) return undefined;
  if (!isWaiting) return baseElapsedMs;
  // `tick` is read so the render follows the interval.
  void tick;
  return anchorRef.current.elapsedMs + (Date.now() - anchorRef.current.at);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
