import type { UIMessage, UseChatStatus } from "@anvia/react";
import { Message, useMessage } from "@anvia/react-ui";
import { Pencil, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { CitationsInfoButton } from "#/components/chat/citations-info-button";
import { useMessageCitations } from "#/components/chat/message-citation-context";
import { MessageCopyButton } from "#/components/chat/message-copy-button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import {
  normalizeContextText,
  type ContextSnippetSourceRole,
} from "#/lib/chat/context-snippet-text";
import { resolveMessageCitations } from "#/lib/chat/citations";
import {
  canTargetMessageForTruncate,
  readChatMessageMeta,
} from "#/lib/chat/message-metadata";
import {
  formatMessageBubbleTimestamp,
  formatMessageDateTime,
} from "#/lib/chat/message-time";
import { getMessageRawText } from "#/lib/chat/message-text";

const ACTION_ICON_CLASS =
  "inline-flex cursor-pointer p-0 text-text-faint transition hover:text-text active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Lucide Reply only paints ~y=7–18 of the 24 viewBox, so a size-4
 * instance sits ~40% shorter than Copy/Pencil. Larger 7-unit chevron
 * than stock Reply, paired with a shorter stem + r=5 so the glyph
 * still spans y=1–21 without long jagged diagonals.
 */
function ReplyActionIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M21 21v-8a5 5 0 0 0-5-5H4" />
      <path d="m11 15-7-7 7-7" />
    </svg>
  );
}

export type MessageActionsBarProps = {
  chatStatus: UseChatStatus;
  onRevert: (message: UIMessage) => Promise<void>;
  onStartEdit: (message: UIMessage) => void;
  /** Combined text of the whole generation (assistant footer copy). */
  generationText?: string;
  /** Pin the whole message as additional context. */
  onAddContext: (text: string, sourceRole: ContextSnippetSourceRole) => Promise<boolean>;
};

export function MessageActionsBar({
  chatStatus,
  onRevert,
  onStartEdit,
  generationText,
  onAddContext,
}: MessageActionsBarProps) {
  const { message } = useMessage();
  const messageCitations = useMessageCitations();
  const meta = readChatMessageMeta(message.metadata);
  const isUser = message.role === "user";
  const busy = chatStatus === "streaming";
  const canTruncate = canTargetMessageForTruncate(meta);
  const rawText = getMessageRawText(message);
  const hasText = rawText.trim().length > 0;
  const assistantCitations = useMemo(() => {
    if (message.role !== "assistant") return [];
    if (messageCitations) return messageCitations.citations;
    return resolveMessageCitations({
      rawText,
      metadata: message.metadata,
    }).citations;
  }, [message.role, message.metadata, messageCitations, rawText]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const revertTriggerRef = useRef<HTMLButtonElement>(null);

  // User timestamps live inside the bubble; assistant keeps time in the footer.
  const showFooterTime = !isUser && meta.createdAt;
  const timeLabel = showFooterTime
    ? formatMessageBubbleTimestamp(meta.createdAt!)
    : null;
  const timeTitle = showFooterTime
    ? formatMessageDateTime(meta.createdAt!)
    : null;

  return (
    <>
      <Message.Actions
        className={[
          "mt-0.5 flex items-center gap-3",
          // Always readable on touch; dim until hover/focus on fine pointers.
          "opacity-100 [@media(hover:hover)]:opacity-60",
          "[@media(hover:hover)]:group-hover:opacity-100",
          "focus-within:opacity-100",
          "transition-opacity duration-200",
          "group-data-[role=user]:justify-end",
        ].join(" ")}
      >
        <div className="flex items-center gap-3">
          {!isUser && assistantCitations.length > 0 ? (
            <CitationsInfoButton citations={assistantCitations} />
          ) : null}
          {hasText || (generationText && generationText.trim().length > 0) ? (
            <MessageCopyButton generationText={generationText} />
          ) : null}
          {hasText ? (
            <button
              type="button"
              className={ACTION_ICON_CLASS}
              aria-label="Add message as context"
              title="Add as context"
              onClick={() => {
                const text = normalizeContextText(
                  rawText,
                  isUser ? "user" : "assistant",
                );
                if (text === null) return;
                void onAddContext(text, isUser ? "user" : "assistant");
              }}
            >
              <ReplyActionIcon className="size-4" />
            </button>
          ) : null}

          {isUser ? (
            <>
              <button
                type="button"
                className={ACTION_ICON_CLASS}
                aria-label="Edit message"
                title={
                  busy
                    ? "Wait for the reply to finish"
                    : "Edit message"
                }
                disabled={busy || !hasText}
                onClick={() => onStartEdit(message)}
              >
                <Pencil className="size-4" strokeWidth={1.75} />
              </button>
              <button
                ref={revertTriggerRef}
                type="button"
                className={ACTION_ICON_CLASS}
                aria-label="Regenerate from this message"
                title={
                  busy
                    ? "Wait for the reply to finish"
                    : !canTruncate
                      ? "Cannot regenerate this message"
                      : "Regenerate from this message"
                }
                disabled={busy || !canTruncate}
                onClick={() => {
                  setConfirmError(null);
                  setConfirmOpen(true);
                }}
              >
                <RefreshCw className="size-4" strokeWidth={1.75} />
              </button>
            </>
          ) : null}
        </div>

        {timeLabel && meta.createdAt ? (
          <time
            dateTime={meta.createdAt}
            title={timeTitle ?? undefined}
            className="text-[11px] tabular-nums text-text-faint"
          >
            {timeLabel}
          </time>
        ) : null}
      </Message.Actions>

      <ConfirmDialog
        open={confirmOpen}
        title="Regenerate from this message?"
        description="All messages after this one will be removed from the conversation, then the assistant will reply again."
        confirmLabel="Regenerate"
        cancelLabel="Cancel"
        busy={confirmBusy}
        error={confirmError}
        restoreFocusRef={revertTriggerRef}
        onCancel={() => {
          if (confirmBusy) return;
          setConfirmOpen(false);
          setConfirmError(null);
        }}
        onConfirm={() => {
          if (confirmBusy) return;
          setConfirmBusy(true);
          setConfirmError(null);
          void (async () => {
            try {
              await onRevert(message);
              setConfirmOpen(false);
            } catch (error) {
              setConfirmError(
                error instanceof Error
                  ? error.message
                  : "Could not regenerate from this message",
              );
            } finally {
              setConfirmBusy(false);
            }
          })();
        }}
      />
    </>
  );
}
