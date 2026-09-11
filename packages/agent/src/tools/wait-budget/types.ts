export const STILL_RUNNING_STATUS = "still_running" as const;
export const CANCELLED_STATUS = "cancelled" as const;

export const AWAIT_TOOL_CALL_NAME = "await_tool_call" as const;
export const CANCEL_TOOL_CALL_NAME = "cancel_tool_call" as const;

export const CONTROL_TOOL_NAMES = [AWAIT_TOOL_CALL_NAME, CANCEL_TOOL_CALL_NAME] as const;
export type ControlToolName = (typeof CONTROL_TOOL_NAMES)[number];

export type InFlightToolStatus = "running" | "completed" | "cancelled" | "failed";

export type ToolWaitProgressPhase =
  | "running"
  | "wait_elapsed"
  | "awaiting"
  | "cancelled"
  | "completed"
  | "failed";

export type StillRunningResult = {
  status: typeof STILL_RUNNING_STATUS;
  toolCallId: string;
  toolName: string;
  elapsedMs: number;
  waitCount: number;
  progressMoved: boolean;
  mustInformUser: true;
  next: readonly [typeof AWAIT_TOOL_CALL_NAME, typeof CANCEL_TOOL_CALL_NAME];
  stage?: string;
};

export type CancelledToolResult = {
  status: typeof CANCELLED_STATUS;
  toolCallId: string;
  toolName: string;
  elapsedMs: number;
  stage?: string;
};

export type ToolWaitProgress = {
  toolCallId: string;
  toolName: string;
  phase: ToolWaitProgressPhase;
  elapsedMs: number;
  waitCount: number;
  stage?: string;
};

export type ObserveResult =
  | { kind: "settled"; output: unknown }
  | { kind: "still_running"; payload: StillRunningResult }
  | { kind: "cancelled"; payload: CancelledToolResult }
  | { kind: "failed"; error: unknown };

export function isControlToolName(name: string): name is ControlToolName {
  return name === AWAIT_TOOL_CALL_NAME || name === CANCEL_TOOL_CALL_NAME;
}

export function isStillRunningResult(value: unknown): value is StillRunningResult {
  if (typeof value !== "object" || value === null) return false;
  return (value as { status?: unknown }).status === STILL_RUNNING_STATUS;
}
