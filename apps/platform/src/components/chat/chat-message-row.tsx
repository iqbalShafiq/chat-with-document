import type { UIMessage, UIMessagePart, UseChatStatus } from "@anvia/react";
import { Message, useMessage } from "@anvia/react-ui";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { MessageActionsBar } from "#/components/chat/message-actions-bar";
import { MessageCitationProvider } from "#/components/chat/message-citation-context";
import { ConversationSummaryDivider } from "#/components/chat/conversation-summary-divider";
import { ErrorMessageBubble } from "#/components/chat/error-message-bubble";
import { UserMessageEdit } from "#/components/chat/user-message-edit";
import { GeneratedImageStrip } from "#/components/images/generated-image-strip";
import { GeneratedImageThumbnail } from "#/components/images/generated-image-thumbnail";
import { MathMarkdown } from "#/components/math-markdown";
import { ReasoningPanel } from "#/components/reasoning-panel";
import { ToolActivityPanel } from "#/components/tool-activity-panel";
import { resolveMessageCitations } from "#/lib/chat/citations";
import { readChatMessageMeta } from "#/lib/chat/message-metadata";
import {
  imageItemsFromToolPart,
  isImageToolName,
} from "#/lib/chat/generated-images";
import {
  formatMessageBubbleTimestamp,
  formatMessageDateTime,
} from "#/lib/chat/message-time";
import {
  getMessageRawText,
  messageHasUserFacingText,
} from "#/lib/chat/message-text";

function shouldShowMessageActions(
  message: UIMessage,
  isGenerationEnd: boolean,
): boolean {
  if (message.role === "user") return true;
  if (message.role === "tool") return false;
  if (message.role !== "assistant") return false;
  // Copy/timestamp footer only on the FINAL assistant message of a
  // generation — an agent turn may emit several assistant messages
  // (reply → tool → thinking → reply) and the footer belongs at the bottom.
  return isGenerationEnd;
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

/**
 * Memoized row: re-renders only when its own message (or the passed-in
 * stream/edit state) changes. @anvia/react keeps unchanged message objects
 * by reference, so a model switch — which re-renders the parent thread —
 * no longer re-parses markdown/formatting for every message.
 */
export const ChatMessageRow = memo(function ChatMessageRow({
  message: messageProp,
  chatStatus,
  lastMessageId,
  editingMessageId,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRevert,
  generationInfo,
}: {
  message: UIMessage;
  chatStatus: UseChatStatus;
  lastMessageId?: string;
  editingMessageId: string | null;
  onStartEdit: (message: UIMessage) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (message: UIMessage, text: string) => Promise<void>;
  onRevert: (message: UIMessage) => Promise<void>;
  /** Generation footer info — only the final assistant message shows it. */
  generationInfo?: { isGenerationEnd: boolean; generationText: string };
}) {
  const message = messageProp;
  const messageKind = readChatMessageMeta(message.metadata).kind;

  if (messageKind === "summary") {
    return (
      <div
        data-role={message.role}
        data-message-id={message.id}
        className="relative flex w-full min-w-0 flex-col"
      >
        <ConversationSummaryDivider />
      </div>
    );
  }

  if (messageKind === "error") {
    return (
      <div
        data-role={message.role}
        data-message-id={message.id}
        className="relative flex w-full min-w-0 flex-col"
      >
        <ErrorMessageBubble
          text={getMessageRawText(message) || "Something went wrong"}
        />
      </div>
    );
  }

  const contentRef = useRef<HTMLDivElement>(null);
  const [editWidthPx, setEditWidthPx] = useState<number | null>(null);
  const intermediate = isIntermediateStepMessage(message);
  const startsWithActivity = messageStartsWithActivity(message);
  const showActions = shouldShowMessageActions(
    message,
    generationInfo?.isGenerationEnd ?? true,
  );
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
            generationText={generationInfo?.generationText}
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
});

type MessagePart = UIMessage["parts"][number];

function isRenderablePart(part: MessagePart, role: UIMessage["role"]): boolean {
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "reasoning" || part.type === "tool") return true;
  if (part.type === "attachment") {
    // Image attachments (active image context) render in the user bubble.
    return role === "user" && part.attachment?.type === "image";
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
  "[&>[data-part=text]+[data-part=reasoning]]:mt-4",
  "[&>[data-part=text]+[data-part=tool]]:mt-4",
].join(" ");

function ChatMessageParts({
  chatStatus,
  lastMessageId,
}: {
  chatStatus: UseChatStatus;
  lastMessageId?: string;
}) {
  const { message } = useMessage();

  // Group consecutive image tool parts into runs — a multi-image generation
  // (n > 1) or repeated generate/edit calls with no text between them render
  // as one horizontal scrollable strip instead of separate grids.
  const imageRuns = useMemo(() => {
    type ToolPart = Extract<UIMessagePart, { type: "tool" }>;
    const runs: ToolPart[][] = [];
    let current: ToolPart[] = [];
    for (const part of message.parts) {
      if (part.type === "tool" && isImageToolName(part.toolName)) {
        current.push(part);
      } else if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length > 0) runs.push(current);
    return runs;
  }, [message.parts]);

  const stripForPart = useMemo(() => {
    const byFirst = new Map<
      Extract<UIMessagePart, { type: "tool" }>,
      Array<Extract<UIMessagePart, { type: "tool" }>>
    >();
    for (const run of imageRuns) {
      if (run.length > 0) byFirst.set(run[0]!, run);
    }
    return byFirst;
  }, [imageRuns]);

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
          const run = stripForPart.get(part);
          const isRunStart = run !== undefined;
          const runImages = isRunStart
            ? run.flatMap((runPart) => imageItemsFromToolPart(runPart))
            : [];
          const uniqueRunImages = [
            ...new Map(runImages.map((image) => [image.id, image])).values(),
          ];
          return (
            <Message.Part className="min-w-0 max-w-full">
              <ToolActivityPanel part={part} />
              {isRunStart && uniqueRunImages.length > 0 ? (
                uniqueRunImages.length > 1 ? (
                  <GeneratedImageStrip images={uniqueRunImages} />
                ) : (
                  <div className="mt-2 max-w-md">
                    <GeneratedImageThumbnail image={uniqueRunImages[0]!} />
                  </div>
                )
              ) : null}
            </Message.Part>
          );
        }

        if (part.type === "attachment" && part.attachment?.type === "image") {
          const src =
            part.attachment.data ??
            part.attachment.url ??
            "";
          return (
            <Message.Part className="min-w-0 max-w-full">
              {src ? (
                <div className="mt-1.5 flex max-w-md flex-wrap gap-1.5">
                  <img
                    src={src}
                    alt={part.attachment.name ?? "Attached image"}
                    className="size-24 rounded-lg border border-white/[0.08] object-cover"
                  />
                </div>
              ) : null}
            </Message.Part>
          );
        }

        return null;
      }}
    </Message.Parts>
  );
}
