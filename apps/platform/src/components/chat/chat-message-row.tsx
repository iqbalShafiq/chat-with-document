import type { UIMessage, UseChatStatus } from "@anvia/react";
import { Message, useMessage } from "@anvia/react-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageActionsBar } from "#/components/chat/message-actions-bar";
import { MessageCitationProvider } from "#/components/chat/message-citation-context";
import { UserMessageEdit } from "#/components/chat/user-message-edit";
import { MathMarkdown } from "#/components/math-markdown";
import { ReasoningPanel } from "#/components/reasoning-panel";
import { ToolActivityPanel } from "#/components/tool-activity-panel";
import { resolveMessageCitations } from "#/lib/chat/citations";
import { readChatMessageMeta } from "#/lib/chat/message-metadata";
import {
  formatMessageBubbleTimestamp,
  formatMessageDateTime,
} from "#/lib/chat/message-time";
import {
  getMessageRawText,
  messageHasUserFacingText,
} from "#/lib/chat/message-text";

function shouldShowMessageActions(message: UIMessage): boolean {
  if (message.role === "user") return true;
  if (message.role === "tool") return false;
  if (message.role !== "assistant") return false;
  return messageHasUserFacingText(message);
}

function isIntermediateStepMessage(message: UIMessage): boolean {
  if (message.role === "tool") return true;
  if (message.role !== "assistant") return false;
  return !messageHasUserFacingText(message);
}

/**
 * True when the first *visible* part is reasoning/tool (not answer text).
 * Used so cross-message spacing stays tight for tool → reasoning even when
 * the next assistant message also contains the final text later.
 */
function messageStartsWithActivity(message: UIMessage): boolean {
  if (message.role === "tool") return true;
  if (message.role !== "assistant") return false;
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim().length > 0) return false;
      continue;
    }
    if (part.type === "reasoning" || part.type === "tool") return true;
    if (part.type === "attachment") continue;
  }
  return false;
}

export function ChatMessageRow({
  chatStatus,
  lastMessageId,
  editingMessageId,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRevert,
}: {
  chatStatus: UseChatStatus;
  lastMessageId?: string;
  editingMessageId: string | null;
  onStartEdit: (message: UIMessage) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (message: UIMessage, text: string) => Promise<void>;
  onRevert: (message: UIMessage) => Promise<void>;
}) {
  const { message } = useMessage();
  const contentRef = useRef<HTMLDivElement>(null);
  const [editWidthPx, setEditWidthPx] = useState<number | null>(null);
  const intermediate = isIntermediateStepMessage(message);
  const startsWithActivity = messageStartsWithActivity(message);
  const showActions = shouldShowMessageActions(message);
  const isEditing =
    message.role === "user" && editingMessageId === message.id;

  const userMeta = readChatMessageMeta(message.metadata);
  const userTimeLabel =
    message.role === "user" && userMeta.createdAt
      ? formatMessageBubbleTimestamp(userMeta.createdAt)
      : null;
  const userTimeTitle =
    message.role === "user" && userMeta.createdAt
      ? formatMessageDateTime(userMeta.createdAt)
      : null;

  useEffect(() => {
    if (!isEditing) setEditWidthPx(null);
  }, [isEditing]);

  const rawText = getMessageRawText(message);
  const assistantCitations = useMemo(() => {
    if (message.role !== "assistant") return [];
    return resolveMessageCitations({
      rawText,
      metadata: message.metadata,
    }).citations;
  }, [message.role, message.metadata, rawText]);

  const row = (
    <div
      data-role={message.role}
      data-message-id={message.id}
      data-activity-only={intermediate ? "" : undefined}
      data-starts-activity={startsWithActivity ? "" : undefined}
      className="relative flex w-full min-w-0 flex-col"
    >
      <Message.Root
        className={`group grid w-full min-w-0 data-[role=user]:justify-items-end data-[role=assistant]:justify-items-start ${
          intermediate ? "gap-1" : "gap-1.5"
        }`}
      >
        <Message.Content
          ref={contentRef}
          className="glass-bubble min-w-0 max-w-full text-sm leading-relaxed group-data-[role=user]:max-w-[min(100%,42rem)] group-data-[role=user]:rounded-2xl group-data-[role=user]:px-4 group-data-[role=user]:py-3 group-data-[role=user]:text-text group-data-[role=assistant]:w-full group-data-[role=assistant]:max-w-full group-data-[role=assistant]:text-text"
          style={
            isEditing && editWidthPx
              ? { width: editWidthPx, maxWidth: editWidthPx }
              : undefined
          }
        >
          {isEditing ? (
            <UserMessageEdit
              initialText={rawText}
              busy={chatStatus === "streaming"}
              onCancel={onCancelEdit}
              onSubmit={(text) => onSubmitEdit(message, text)}
            />
          ) : (
            <>
              <ChatMessageParts
                chatStatus={chatStatus}
                lastMessageId={lastMessageId}
              />
              {userTimeLabel && userMeta.createdAt ? (
                <time
                  dateTime={userMeta.createdAt}
                  title={userTimeTitle ?? undefined}
                  className="mt-1.5 block text-right text-[11px] tabular-nums text-text-faint"
                >
                  {userTimeLabel}
                </time>
              ) : null}
            </>
          )}
        </Message.Content>

        {showActions && !isEditing ? (
          <MessageActionsBar
            chatStatus={chatStatus}
            onRevert={onRevert}
            onStartEdit={(target) => {
              const width = contentRef.current?.getBoundingClientRect().width;
              if (typeof width === "number" && width > 0) {
                setEditWidthPx(Math.round(width));
              }
              onStartEdit(target);
            }}
          />
        ) : null}
      </Message.Root>
    </div>
  );

  if (message.role === "assistant") {
    return (
      <MessageCitationProvider citations={assistantCitations}>
        {row}
      </MessageCitationProvider>
    );
  }

  return row;
}

type MessagePart = UIMessage["parts"][number];

function isRenderablePart(part: MessagePart, role: UIMessage["role"]): boolean {
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "reasoning" || part.type === "tool") return true;
  if (part.type === "attachment") {
    void role;
    return false;
  }
  return false;
}

const PARTS_STACK_CLASS = [
  "flex min-w-0 max-w-full flex-col",
  "[&>[data-part=reasoning]+[data-part=tool]]:mt-1",
  "[&>[data-part=tool]+[data-part=reasoning]]:mt-1",
  "[&>[data-part=tool]+[data-part=tool]]:mt-1",
  "[&>[data-part=reasoning]+[data-part=reasoning]]:mt-1",
  "[&>[data-part=reasoning]+[data-part=text]]:mt-4",
  "[&>[data-part=tool]+[data-part=text]]:mt-4",
].join(" ");

function ChatMessageParts({
  chatStatus,
  lastMessageId,
}: {
  chatStatus: UseChatStatus;
  lastMessageId?: string;
}) {
  const { message } = useMessage();

  return (
    <Message.Parts
      filter={(part) => isRenderablePart(part, message.role)}
      className={PARTS_STACK_CLASS}
      stream={{
        isStreaming:
          chatStatus === "streaming" &&
          message.role === "assistant" &&
          lastMessageId === message.id,
        resetKey: message.id,
        flushImmediately: chatStatus === "error",
      }}
    >
      {(part) => {
        if (part.type === "text") {
          return (
            <Message.Part className="min-w-0 max-w-full">
              <MathMarkdown />
            </Message.Part>
          );
        }

        if (part.type === "reasoning") {
          return (
            <Message.Part className="min-w-0 max-w-full">
              <ReasoningPanel
                isStreamingMessage={
                  chatStatus === "streaming" && lastMessageId === message.id
                }
              />
            </Message.Part>
          );
        }

        if (part.type === "tool") {
          return (
            <Message.Part className="min-w-0 max-w-full">
              <ToolActivityPanel part={part} />
            </Message.Part>
          );
        }

        return null;
      }}
    </Message.Parts>
  );
}
