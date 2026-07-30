import type { UIMessage, UseChatStatus } from "@anvia/react";
import { Message, useMessage } from "@anvia/react-ui";
import { DocumentAttachmentChip } from "#/components/chat/document-attachment-chip";
import { MathMarkdown } from "#/components/math-markdown";
import { ReasoningPanel } from "#/components/reasoning-panel";
import { ToolActivityPanel } from "#/components/tool-activity-panel";
import { Copy, RefreshCw } from "lucide-react";

type AttachedDocumentMeta = {
  name: string;
  mediaType?: string;
};

function attachedDocumentsFromMetadata(
  metadata: UIMessage["metadata"],
): AttachedDocumentMeta[] {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !Array.isArray(metadata.attachedDocuments)
  ) {
    return [];
  }

  return metadata.attachedDocuments.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const name =
      "name" in item && typeof item.name === "string" ? item.name : null;
    if (!name) return [];
    const mediaType =
      "mediaType" in item && typeof item.mediaType === "string"
        ? item.mediaType
        : undefined;
    return mediaType === undefined ? [{ name }] : [{ name, mediaType }];
  });
}

function messageHasUserFacingText(message: UIMessage): boolean {
  return message.parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
}

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
}: {
  chatStatus: UseChatStatus;
  lastMessageId?: string;
}) {
  const { message } = useMessage();
  const intermediate = isIntermediateStepMessage(message);
  const startsWithActivity = messageStartsWithActivity(message);
  const showActions = shouldShowMessageActions(message);

  return (
    <Message.Root
      data-activity-only={intermediate ? "" : undefined}
      data-starts-activity={startsWithActivity ? "" : undefined}
      className={`group grid w-full data-[role=user]:justify-items-end data-[role=assistant]:justify-items-start ${
        intermediate ? "gap-1" : "gap-1.5"
      }`}
    >
      <Message.Content className="glass-bubble max-w-full text-sm leading-relaxed group-data-[role=user]:max-w-[min(100%,42rem)] group-data-[role=user]:rounded-2xl group-data-[role=user]:px-4 group-data-[role=user]:py-3 group-data-[role=user]:text-text group-data-[role=assistant]:w-full group-data-[role=assistant]:max-w-full group-data-[role=assistant]:text-text">
        <ChatMessageParts
          chatStatus={chatStatus}
          lastMessageId={lastMessageId}
        />
      </Message.Content>

      {showActions ? (
        <Message.Actions className="mt-0.5 flex items-center gap-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-data-[role=user]:justify-end">
          <Message.Copy
            aria-label="Copy"
            className="inline-flex cursor-pointer p-0 text-text-faint transition hover:text-text active:scale-[0.98]"
          >
            <Copy className="size-4" strokeWidth={1.75} />
          </Message.Copy>
          <Message.Regenerate
            aria-label="Retry"
            className="inline-flex cursor-pointer p-0 text-text-faint transition hover:text-text active:scale-[0.98]"
          >
            <RefreshCw className="size-4" strokeWidth={1.75} />
          </Message.Regenerate>
        </Message.Actions>
      ) : null}
    </Message.Root>
  );
}

type MessagePart = UIMessage["parts"][number];

/** Drop empty text so it cannot sit between tool ↔ reasoning and invent gaps. */
function isRenderablePart(part: MessagePart): boolean {
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "reasoning" || part.type === "tool") return true;
  if (part.type === "attachment") return true;
  return false;
}

/*
  Spacing is CSS sibling-based (Message.Part sets data-part={type}):
  - activity ↔ activity (any order): tight
  - activity → response text: roomy
*/
const PARTS_STACK_CLASS = [
  "flex flex-col",
  // reasoning ↔ tool stack (both directions, and same-type repeats)
  "[&>[data-part=reasoning]+[data-part=tool]]:mt-1",
  "[&>[data-part=tool]+[data-part=reasoning]]:mt-1",
  "[&>[data-part=tool]+[data-part=tool]]:mt-1",
  "[&>[data-part=reasoning]+[data-part=reasoning]]:mt-1",
  // activity → final answer
  "[&>[data-part=reasoning]+[data-part=text]]:mt-4",
  "[&>[data-part=tool]+[data-part=text]]:mt-4",
  // attachments
  "[&>[data-part=attachment]+[data-part]]:mt-2",
  "[&>[data-part]+[data-part=attachment]]:mt-2",
].join(" ");

function ChatMessageParts({
  chatStatus,
  lastMessageId,
}: {
  chatStatus: UseChatStatus;
  lastMessageId?: string;
}) {
  const { message } = useMessage();
  const hasAttachmentParts = message.parts.some(
    (part) => part.type === "attachment",
  );
  const metadataAttachments = attachedDocumentsFromMetadata(message.metadata);

  return (
    <>
      <Message.Parts
        filter={isRenderablePart}
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
              <Message.Part
                className="[&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-white/[0.04] [&_pre]:p-3 [&_pre]:text-text [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.katex-display]:my-3 [&_.katex]:text-[1.05em] group-data-[role=user]:[&_code]:bg-white/[0.08] group-data-[role=user]:[&_a]:text-accent"
              >
                <MathMarkdown />
              </Message.Part>
            );
          }

          if (part.type === "attachment") {
            const name = part.attachment.name ?? "Document";
            return (
              <Message.Part>
                <DocumentAttachmentChip
                  name={name}
                  mediaType={part.attachment.mediaType}
                />
              </Message.Part>
            );
          }

          if (part.type === "reasoning") {
            return (
              <Message.Part>
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
              <Message.Part>
                <ToolActivityPanel part={part} />
              </Message.Part>
            );
          }

          return null;
        }}
      </Message.Parts>

      {!hasAttachmentParts && metadataAttachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {metadataAttachments.map((doc, index) => (
            <DocumentAttachmentChip
              key={`${doc.name}-${index}`}
              name={doc.name}
              mediaType={doc.mediaType}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
