import type {
  ClientDataMap,
  ClientMetadata,
  UIMessage,
  UIMessagePart,
} from "@anvia/client";

/** Strict JSON value, matching the client's tool-output contract. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
import {
  HIDDEN_CONTROL_TOOL_NAMES,
  isStillRunningToolOutput,
} from "#/lib/chat/tool-wait-progress";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

const UNFINISHED_WAIT_MESSAGE = "This tool did not finish.";

export type ReconcileWaitedToolsOptions = {
  /**
   * Also settle cards that were waited on but never produced a real result.
   * Use it on a live terminal frame, where `finalizeInterruptedTools` is not
   * part of the same flow; leave it off when finalize runs right after, so the
   * two helpers do not both own the same decision.
   */
  markUnfinished?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Unwrap the client's `{ type, value }` envelope when present.
 *
 * Tool outputs arrive in both shapes: an envelope for structured results and a
 * bare value for scalar ones. A text-only tool such as deep_research returns
 * its report as a plain string, so primitives must pass through unchanged.
 */
function unwrapToolValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if ("value" in record && (record.type === "json" || record.type === "text")) {
    return record.value as JsonValue;
  }
  return value as JsonValue;
}

/** The in-flight call a wait/cancel control tool observed. */
function observedToolCallId(part: ToolPart): string | null {
  if (!HIDDEN_CONTROL_TOOL_NAMES.has(part.toolName)) return null;
  const input = asRecord(unwrapToolValue(part.input));
  const id = input?.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Map each wait/cancel result onto the tool call it observed.
 *
 * A waited tool's own part only ever holds the `still_running` checkpoint, so
 * without this the original card would keep showing "Waiting" even though the
 * real result (or cancellation) already arrived through the control call.
 */
function collectWaitedResults(
  messages: readonly UIMessage<ClientMetadata, ClientDataMap>[],
): Map<string, JsonValue> {
  const results = new Map<string, JsonValue>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      if (part.state !== "output-available") continue;
      const target = observedToolCallId(part);
      if (!target) continue;
      const value = unwrapToolValue(part.output);
      // Another checkpoint carries no outcome; the call is still running.
      if (value === undefined || isStillRunningToolOutput(value)) continue;
      results.set(target, value);
    }
  }
  return results;
}

/**
 * Settle tool cards whose work finished through a wait or cancel control call.
 *
 * Run this before `finalizeInterruptedTools`: finalizing first would turn every
 * still_running card into an error and lose the awaited result. A cancelled
 * result is copied as-is so the card renders its own "Cancelled" state.
 */
export function reconcileWaitedTools<
  Metadata extends ClientMetadata = ClientMetadata,
  Data extends ClientDataMap = ClientDataMap,
>(
  messages: UIMessage<Metadata, Data>[],
  options: ReconcileWaitedToolsOptions = {},
): UIMessage<Metadata, Data>[] {
  const results = collectWaitedResults(
    messages as readonly UIMessage<ClientMetadata, ClientDataMap>[],
  );
  const markUnfinished = options.markUnfinished === true;
  if (results.size === 0 && !markUnfinished) return messages;

  let anyChanged = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      if (part.state !== "output-available") return part;
      if (HIDDEN_CONTROL_TOOL_NAMES.has(part.toolName)) return part;
      if (!isStillRunningToolOutput(part.output)) return part;
      const resolved = results.get(part.toolCallId);
      if (resolved !== undefined) {
        messageChanged = true;
        return { ...part, output: resolved };
      }
      if (!markUnfinished) return part;
      messageChanged = true;
      return {
        ...part,
        state: "error" as const,
        error: { message: UNFINISHED_WAIT_MESSAGE },
      };
    });
    if (!messageChanged) return message;
    anyChanged = true;
    return { ...message, parts };
  });
  return anyChanged ? next : messages;
}