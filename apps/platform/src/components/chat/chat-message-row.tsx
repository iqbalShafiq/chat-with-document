import type { UIMessage, UIMessagePart, UseChatStatus } from "@anvia/react";
import { Message, useMessage } from "@anvia/react-ui";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { MessageActionsBar } from "#/components/chat/message-actions-bar";
import { ContextSnippetChip } from "#/components/chat/context-snippet-chip";
import { MessageCitationProvider } from "#/components/chat/message-citation-context";
import { MessageSelectionToolbar } from "#/components/chat/message-selection-toolbar";
import { ConversationSummaryDivider } from "#/components/chat/conversation-summary-divider";
import { ErrorMessageBubble } from "#/components/chat/error-message-bubble";
import { UserMessageEdit } from "#/components/chat/user-message-edit";
import { GeneratedImageStrip } from "#/components/images/generated-image-strip";
import { GeneratedImageThumbnail } from "#/components/images/generated-image-thumbnail";
import { useImagePreview } from "#/components/images/image-preview";
import { MathMarkdown } from "#/components/math-markdown";import { ReasoningPanel } from "#/components/reasoning-panel";
import { ToolActivityPanel } from "#/components/tool-activity-panel";
import { resolveMessageCitations } from "#/lib/chat/citations";
import { readChatMessageMeta } from "#/lib/chat/message-metadata";
import {
  imageItemsFromToolPart,
  isMessageImageToolName,
  type GeneratedImageItem,
} from "#/lib/chat/generated-images";
import {
  formatMessageBubbleTimestamp,
  formatMessageDateTime,
} from "#/lib/chat/message-time";
import type { ContextSnippetSourceRole } from "#/lib/chat/context-snippet-text";
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
/**
 * Minimum width for the edit bubble so the Cancel / Save & resubmit row fits
 * on one line even when the message text is very short.
 */
const EDIT_BUBBLE_MIN_WIDTH = 264;

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
  editContextImages,
  editAvailableImages,
  onEditContextAdd,
  onEditContextRemove,
  onAddContext,
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
  /** Context images managed inside the edit bubble (view / add / remove). */
  editContextImages?: GeneratedImageItem[];
  editAvailableImages?: GeneratedImageItem[];
  onEditContextAdd?: (image: GeneratedImageItem) => void;
  onEditContextRemove?: (image: GeneratedImageItem) => void;
  /** Wired in Task 8 — declared now so routes/index.tsx can pass it. */
  onAddContext?: (
    text: string,
    sourceRole: ContextSnippetSourceRole,
  ) => Promise<boolean>;
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
  const messageContextSnippet =
    message.role === "user" && userMeta.contextSnippet
      ? userMeta.contextSnippet
      : null;
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
              ? {
                  // Keep the bubble at the message's width, but never below
                  // the minimum that fits the Cancel / Save & resubmit row.
                  width: editWidthPx,
                  minWidth: EDIT_BUBBLE_MIN_WIDTH,
                  maxWidth: editWidthPx,
                }
              : undefined
          }
        >
          {isEditing ? (
            <UserMessageEdit
              initialText={rawText}
              busy={chatStatus === "streaming"}
              onCancel={onCancelEdit}
              onSubmit={(text) => onSubmitEdit(message, text)}
              contextImages={editContextImages}
              availableImages={editAvailableImages}
              onAddContextImage={onEditContextAdd}
              onRemoveContextImage={onEditContextRemove}
            />
          ) : (
            <>
              {messageContextSnippet ? (
                <ContextSnippetChip
                  snippet={{
                    id: "inline",
                    text: messageContextSnippet.text,
                    sourceRole: messageContextSnippet.sourceRole,
                    createdAt: "",
                  }}
                  variant="bubble"
                />
              ) : null}
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

        {message.role === "user" || message.role === "assistant" ? (
          <MessageSelectionToolbar
            containerRef={contentRef}
            role={message.role === "user" ? "user" : "assistant"}
            disabled={isEditing}
            onAddContext={(text, sourceRole) =>
              onAddContext ? onAddContext(text, sourceRole) : Promise.resolve(false)
            }
          />
        ) : null}

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
            onAddContext={(text, sourceRole) =>
              onAddContext ? onAddContext(text, sourceRole) : Promise.resolve(false)
            }
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
type AttachmentImagePart = Extract<MessagePart, { type: "attachment" }>;

/**
 * Rebuilt-from-memory attachments carry RAW base64 in `data` (no `data:`
 * prefix), while live composer attachments already carry a data URL. Normalize
 * so the <img> always has a loadable src.
 */
function attachmentImageSrc(part: AttachmentImagePart): string {
  const attachment = part.attachment;
  const raw = attachment.data ?? attachment.url ?? "";
  if (!raw) return "";
  if (/^(data:|blob:|https?:|file:)/i.test(raw)) return raw;
  return `data:${attachment.mediaType ?? "image/png"};base64,${raw}`;
}

function AttachmentImageTile({ part }: { part: AttachmentImagePart }) {
  const { open } = useImagePreview();
  const src = attachmentImageSrc(part);
  if (!src) return null;
  const alt = part.attachment.name ?? "Attached image";
  return (
    <button
      type="button"
      onClick={() => open({ src, alt })}
      title="View image"
      className="block cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.08] transition hover:border-white/[0.18] active:scale-[0.98]"
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="size-24 object-cover"
      />
    </button>
  );
}

/** Horizontal scrollable strip for consecutive image attachments. */
function AttachmentImageStrip({ parts }: { parts: AttachmentImagePart[] }) {
  return (
    <div
      className="chat-scroll-x mt-1.5 flex max-w-full gap-1.5 overflow-x-auto pb-1.5"
      role="list"
      aria-label="Attached images"
    >
      {parts.map((part) => (
        <div key={part.id} className="shrink-0" role="listitem">
          <AttachmentImageTile part={part} />
        </div>
      ))}
    </div>
  );
}

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
      if (part.type === "tool" && isMessageImageToolName(part.toolName)) {
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

  // Consecutive user image attachments (pinned image context) render as one
  // horizontal scrollable strip instead of separate blocks.
  const attachmentImageRuns = useMemo(() => {
    const runs: AttachmentImagePart[][] = [];
    let current: AttachmentImagePart[] = [];
    for (const part of message.parts) {
      if (part.type === "attachment" && part.attachment?.type === "image") {
        current.push(part);
      } else if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length > 0) runs.push(current);
    return runs;
  }, [message.parts]);

  const attachmentStripForPart = useMemo(() => {
    const byFirst = new Map<AttachmentImagePart, AttachmentImagePart[]>();
    for (const run of attachmentImageRuns) {
      if (run.length > 0) byFirst.set(run[0]!, run);
    }
    return byFirst;
  }, [attachmentImageRuns]);

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
          const run = attachmentStripForPart.get(part);
          if (!run) return null; // rendered by the strip of the run's first part
          return (
            <Message.Part className="min-w-0 max-w-full">
              {run.length > 1 ? (
                <AttachmentImageStrip parts={run} />
              ) : (
                <div className="mt-1.5">
                  <AttachmentImageTile part={run[0]!} />
                </div>
              )}
            </Message.Part>
          );
        }

        return null;
      }}
    </Message.Parts>
  );
}
