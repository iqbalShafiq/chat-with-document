import type { ClientDataMap, ClientMetadata, UIMessage, UIMessagePart } from "@anvia/client";
import { reconcileWaitedTools } from "#/lib/chat/reconcile-waited-tools";
import { isStillRunningToolOutput } from "#/lib/chat/tool-wait-progress";

const STOPPED_TOOL_MESSAGE = "Stopped before this tool finished.";

function isUnfinishedWait(part: Extract<UIMessagePart, { type: "tool" }>): boolean {
  if (part.state !== "output-available") return false;
  return isStillRunningToolOutput(part.output);
}

export type FinalizeInterruptedToolsOptions = {
  /**
   * Tool names to leave untouched because they are waiting on the user.
   *
   * A run that suspends for approval ends its stream too, so the tool that
   * asked for approval has no result yet — the same shape as an interrupted
   * tool. Finalizing it would render "Stopped before this tool finished."
   * right next to the approval card that is asking for that very tool.
   */
  keepPendingApprovalTools?: ReadonlySet<string>;
};

/**
 * Mark in-flight tool parts as errored so the activity panel shows Error
 * instead of forever-"Working" after a mid-run stop or a history reload of
 * an incomplete tool_call (no matching tool_result in memory).
 *
 * `input-streaming` / `input-available` → `error`. Done / already-error parts
 * are left alone.
 *
 * This assumes the run is over. During a live run the same shapes also describe
 * work that is simply still in flight; callers must therefore only reach here
 * once the run has actually stopped (see `settleStoppedRunTools` for the one
 * stop that still owes the user a decision).
 */
export function finalizeInterruptedTools<
  Metadata extends ClientMetadata = ClientMetadata,
  Data extends ClientDataMap = ClientDataMap,
>(
  messages: UIMessage<Metadata, Data>[],
  reason: string = STOPPED_TOOL_MESSAGE,
  options: FinalizeInterruptedToolsOptions = {},
): UIMessage<Metadata, Data>[] {
  const keep = options.keepPendingApprovalTools;
  let anyChanged = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      if (part.state === "error") return part;
      const settled = part.state === "output-available" && !isUnfinishedWait(part);
      if (settled) return part;
      // Only an unfinished part can be the one waiting for approval; a finished
      // call of the same tool earlier in the turn is unaffected.
      if (keep?.has(part.toolName)) return part;
      messageChanged = true;
      return {
        ...part,
        state: "error" as const,
        error: { message: reason },
      };
    });
    if (!messageChanged) return message;
    anyChanged = true;
    return { ...message, parts };
  });
  return anyChanged ? next : messages;
}

/**
 * Settle the tool cards of a run that has ended, except the ones still waiting
 * for the user's decision.
 *
 * Run this instead of calling `finalizeInterruptedTools` directly whenever a
 * pending approval may exist, so an approval prompt never sits above an error
 * card for the same tool.
 */
export type SettleStoppedRunToolsOptions = {
  /** Approvals still awaiting a decision; their cards stay open. */
  pendingApprovalToolNames?: Iterable<string>;
};

/**
 * Settle the tool cards of a run that has ended.
 *
 * An unfinished card is not stopped work when either:
 * - its approval is still pending, because that prompt is still open; or
 * - the same tool produced a later part in the same transcript, because then
 *   the card was superseded: answering an approval resumes the run as a new
 *   attempt, the tool runs again under a new call id, and its result lands on
 *   the new attempt rather than on the card that asked for approval.
 *
 * Anything else that never finished is genuinely interrupted.
 */
export function settleStoppedRunTools<
  Metadata extends ClientMetadata = ClientMetadata,
  Data extends ClientDataMap = ClientDataMap,
>(
  messages: UIMessage<Metadata, Data>[],
  options: SettleStoppedRunToolsOptions = {},
  reason?: string,
): UIMessage<Metadata, Data>[] {
  const keep = new Set(options.pendingApprovalToolNames ?? []);
  const cleaned = dropSupersededCards(
    messages as UIMessage<ClientMetadata, ClientDataMap>[],
    keep,
  ) as UIMessage<Metadata, Data>[];
  const finalizeOptions = keep.size > 0 ? { keepPendingApprovalTools: keep } : {};
  return finalizeInterruptedTools(
    reconcileWaitedTools(cleaned),
    reason ?? STOPPED_TOOL_MESSAGE,
    finalizeOptions,
  );
}

/**
 * Whether any tool card is still unfinished for reasons other than an approval
 * that is currently waiting on the user.
 *
 * Callers use this after a run ends to decide whether the browser's view needs
 * to be reconciled from server memory.
 */
export function stillOpenToolCards<
  Metadata extends ClientMetadata = ClientMetadata,
  Data extends ClientDataMap = ClientDataMap,
>(
  messages: readonly UIMessage<Metadata, Data>[],
  pendingApprovalToolNames: Iterable<string> = [],
): boolean {
  const keep = new Set(pendingApprovalToolNames);
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          !keep.has(part.toolName) &&
          (part.state === "input-available" || part.state === "input-streaming"),
      ),
  );
}

/**
 * Remove approval-superseded cards whose tool ran again later.
 *
 * Only cards that never reached a result are considered, and only when the
 * approval is no longer pending, so an open prompt or an untouched interrupted
 * call is left for the caller's own handling.
 */
function dropSupersededCards(
  messages: UIMessage<ClientMetadata, ClientDataMap>[],
  pendingApprovalToolNames: ReadonlySet<string>,
): UIMessage<ClientMetadata, ClientDataMap>[] {
  let anyChanged = false;
  const next = messages.map((message, messageIndex) => {
    if (message.role !== "assistant") return message;
    const parts = message.parts.filter((part) => {
      if (part.type !== "tool") return true;
      if (pendingApprovalToolNames.has(part.toolName)) return true;
      if (part.state !== "input-available" && part.state !== "input-streaming") {
        return true;
      }
      return !hasLaterPartForTool(messages, messageIndex, part);
    });
    if (parts.length === message.parts.length) return message;
    anyChanged = true;
    return { ...message, parts };
  });
  return anyChanged ? next : messages;
}

function hasLaterPartForTool(
  messages: readonly UIMessage<ClientMetadata, ClientDataMap>[],
  fromMessageIndex: number,
  original: Extract<UIMessagePart, { type: "tool" }>,
): boolean {
  for (let index = fromMessageIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      if (part.toolName !== original.toolName) continue;
      if (part === original) continue;
      if (part.toolCallId === original.toolCallId) continue;
      return true;
    }
  }
  return false;
}