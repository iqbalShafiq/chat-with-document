import type { UseChatStatus } from "@anvia/react";
import type { UIAttachment } from "@anvia/client";
import { ComposerPrimitive, useComposer } from "@anvia/react-ui";
import { ArrowUp, CornerDownLeft, FileX, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ContextSnippetChip } from "#/components/chat/context-snippet-chip";
import { ComposerAttachControl } from "#/components/composer/composer-attach-control";
import { ContextUsageIndicator } from "#/components/composer/context-usage-indicator";
import { FeaturesPopover } from "#/components/composer/features-popover";
import { MessageQueueDock } from "#/components/composer/message-queue-dock";
import { ModelReasoningSwitcher } from "#/components/composer/model-reasoning-switcher";
import { GeneratedImageThumbnail } from "#/components/images/generated-image-thumbnail";
import type {
  ContextSnippet,
  ContextUsageInfo,
  ImageGenSettings,
  ModelInfo,
  ReasoningEffortInfo,
  SessionDocument,
} from "#/lib/api";
import { isImageAttachmentLike } from "#/lib/api";
import type { GeneratedImageItem } from "#/lib/chat/generated-images";
import type { QueuedDraft, QueuedItem } from "#/lib/chat/queued-messages";
import type { AttachmentReject } from "#/lib/documents/upload-file";

/** 3 cards × 2.5rem + 2 gaps × 0.375rem — taller stacks scroll. */
const ATTACHMENT_ERRORS_MAX_HEIGHT = "max-h-[8.25rem]";

export type ComposerAction = "send" | "queue" | "stop" | "inactive";

export function isActiveComposerStatus(status: UseChatStatus): boolean {
  return status === "submitted" || status === "streaming";
}

export function composerActionForStatus(
  status: UseChatStatus,
  hasContent: boolean,
): ComposerAction {
  if (isActiveComposerStatus(status)) return hasContent ? "queue" : "stop";
  if ((status === "ready" || status === "error") && hasContent) return "send";
  return "inactive";
}

/**
 * Input shell only — must sit inside ComposerPrimitive.Root.
 * Session docs / attachments live in the right SessionDocumentsPanel.
 */
export function ChatComposer({
  sessionId,
  projectId = null,
  activeDocumentIds,
  chatStatus,
  isIngesting,
  composerError,
  attachmentErrors,
  composerInputRef,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  onStopRun,
  onQueueSubmit,
  onLinkedDocuments,
  onAttachmentRejected,
  onDismissAttachmentError,
  models = [],
  reasoningEfforts = [],
  modelsStatus = "loading",
  modelsError = null,
  onRetryModels = () => {},
  contextUsage = null,
  contextUsageError = false,
  webSearchEnabled = false,
  webSearchAvailable = true,
  onWebSearchToggle = () => {},
  deepResearchEnabled = false,
  deepResearchAvailable = true,
  onDeepResearchToggle = () => {},
  imageGenerationEnabled = false,
  imageGenerationAvailable = true,
  onImageGenerationToggle = () => {},
  imageGenSettings = {},
  onImageGenSettingsChange = () => {},
  activeContextImages = [],
  onToggleImageContext = () => {},
  contextSnippet = null,
  contextSnippetError = null,
  onRemoveContextSnippet = () => {},
  queuedItems = [],
  onQueueSendNow = () => {},
  onQueueRemove = () => {},
  onQueueReorder = () => {},
  onQueueRecall = () => {},
  onQueueCancelEdit = () => {},
  editHydration = null,
  clearComposerSignal = null,
  suppressOptimisticClear = null,
}: {
  sessionId: string;
  projectId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
  chatStatus: UseChatStatus;
  isIngesting: boolean;
  composerError: string | null;
  attachmentErrors: AttachmentReject[];
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  model: string;
  reasoningEffort: string | null;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string | null) => void;
  /** Wired in routes/index.tsx — stops the run server-side (worker stop flag). */
  onStopRun?: () => void;
  /** Application-owned active-run queue/steer path. */
  onQueueSubmit?: (
    input: string,
    attachments: UIAttachment[],
  ) => Promise<void> | void;
  onLinkedDocuments?: (documents: SessionDocument[]) => void;
  onAttachmentRejected?: (rejects: AttachmentReject[]) => void;
  onDismissAttachmentError: (id: string) => void;
  models?: ModelInfo[];
  reasoningEfforts?: ReasoningEffortInfo[];
  modelsStatus?: "loading" | "success" | "error";
  modelsError?: string | null;
  onRetryModels?: () => void;
  contextUsage?: ContextUsageInfo | null;
  /** Latest context-usage refresh failed (ring shows a transient hint). */
  contextUsageError?: boolean;
  /** Per-session web-search toggle state (default off). */
  webSearchEnabled?: boolean;
  /** Server has web tools configured (TAVILY_API_KEY). */
  webSearchAvailable?: boolean;
  onWebSearchToggle?: (enabled: boolean) => void;
  /** Per-session Deep Research toggle state (default off). */
  deepResearchEnabled?: boolean;
  /** Available when web search or an active document exists. */
  deepResearchAvailable?: boolean;
  onDeepResearchToggle?: (enabled: boolean) => void;
  /** Per-session image generation toggle state (default off). */
  imageGenerationEnabled?: boolean;
  /** Server has an image model configured. */
  imageGenerationAvailable?: boolean;
  onImageGenerationToggle?: (enabled: boolean) => void;
  /** Capability-driven image generation settings. */
  imageGenSettings?: ImageGenSettings;
  onImageGenSettingsChange?: (settings: ImageGenSettings) => void;
  /** Pinned images sent with the next message — shown above the field. */
  activeContextImages?: GeneratedImageItem[];
  onToggleImageContext?: (image: GeneratedImageItem) => void;
  /** Single pinned text context shown above the field (deletable). */
  contextSnippet?: ContextSnippet | null;
  contextSnippetError?: string | null;
  onRemoveContextSnippet?: () => void;
  /** Queue dock items (send-while-streaming). */
  queuedItems?: QueuedItem[];
  onQueueSendNow?: () => void;
  onQueueRemove?: (id: string) => void;
  onQueueReorder?: (fromIndex: number, toIndex: number) => void;
  onQueueRecall?: (id: string) => void;
  onQueueCancelEdit?: (id: string) => void;
  /** Non-null when a queue item is being edited: hydrate the composer with it. */
  editHydration?: { version: number; draft: QueuedDraft | null } | null;
  /** Queue/cancel actions clear the composer outside a status transition. */
  clearComposerSignal?: { version: number } | null;
  /** When true at stream start, skip the optimistic composer clear (auto-flush). */
  suppressOptimisticClear?: RefObject<boolean> | null;
}) {
  const active = isActiveComposerStatus(chatStatus);
  const busy = isIngesting || active;
  const modelsReady = modelsStatus === "success" && models.length > 0;
  const modelsUnavailable = modelsStatus !== "success";
  // Exit animation state for the context chip: the remove action is deferred
  // ~180ms so the fade-out can play before the snippet unmounts.
  const [removingContext, setRemovingContext] = useState(false);
  // Local photo attachments (image/*) preview above the field; they are
  // uploaded as session images when the message is sent.
  const composer = useComposer();
  const composerHasInput =
    composer.input.trim().length > 0 || composer.attachments.length > 0;
  const composerAction = composerActionForStatus(chatStatus, composerHasInput);
  const queueSubmissionInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const [queueSubmitting, setQueueSubmitting] = useState(false);
  const localImageAttachments = composer.attachments.filter(
    (attachment) => isImageAttachmentLike(attachment),
  );

  const placeholderText =
    active
      ? "The agent is generating…"
      : isIngesting
        ? "Processing document…"
        : "Ask about your documents…";

  const submitQueueDraft = useCallback(async () => {
    if (
      composerAction !== "queue" ||
      onQueueSubmit === undefined ||
      queueSubmissionInFlightRef.current
    ) {
      return;
    }
    queueSubmissionInFlightRef.current = true;
    setQueueSubmitting(true);
    try {
      await onQueueSubmit(composer.input, composer.attachments);
    } finally {
      queueSubmissionInFlightRef.current = false;
      setQueueSubmitting(false);
    }
  }, [composer.attachments, composer.input, composerAction, onQueueSubmit]);

  const requestStop = useCallback(() => {
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    onStopRun?.();
  }, [onStopRun]);

  useEffect(() => {
    if (!active) stopRequestedRef.current = false;
  }, [active]);

  // Optimistic clear: when a run becomes active, empty the composer (text +
  // image attachments) right away. The transition guard is important: the
  // user may type a follow-up while submitted, and the later submitted →
  // streaming transition must not erase that follow-up.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active && !wasActiveRef.current && !suppressOptimisticClear?.current) {
      composer.setInput("");
      composer.clearAttachments();
    }
    wasActiveRef.current = active;
  }, [active, composer, suppressOptimisticClear]);

  // Queue-item edit hydration: replace the composer contents with the item's
  // draft (text + attachments). A null draft clears the editor (cancel edit).
  useEffect(() => {
    if (!editHydration) return;
    composer.setInput(editHydration.draft?.text ?? "");
    composer.setAttachments(editHydration.draft?.attachments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per version bump
  }, [editHydration?.version]);

  // Queue/cancel actions clear the composer outside a status transition
  // (mid-stream clear() crashes the SDK editor — use the safe primitives).
  useEffect(() => {
    if (!clearComposerSignal) return;
    composer.setInput("");
    composer.clearAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per version bump
  }, [clearComposerSignal?.version]);

  // A new snippet always starts non-removing, even if the removal timeout
  // never ran (e.g. the snippet was cleared externally).
  useEffect(() => {
    if (!contextSnippet) setRemovingContext(false);
  }, [contextSnippet]);

  return (
    <div className="glass-composer group/composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
      {modelsStatus === "error" ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in">
          <span className="min-w-0 truncate">
            Model list is unavailable: {modelsError}
          </span>
          <button
            type="button"
            onClick={onRetryModels}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-lg px-2 py-1 font-medium text-danger transition duration-150 hover:bg-white/[0.06] hover:text-danger active:scale-[0.97]"
          >
            Retry
          </button>
        </div>
      ) : null}

      {attachmentErrors.length > 0 ? (
        <div
          className={`chat-scroll flex flex-col gap-1.5 overflow-y-auto overscroll-contain pr-0.5 ${ATTACHMENT_ERRORS_MAX_HEIGHT}`}
          role="alert"
        >
          {attachmentErrors.map((reject) => (
            <div
              key={reject.id}
              className="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in"
            >
              <FileX className="size-4 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {reject.message}
              </span>
              <button
                type="button"
                aria-label={`Dismiss error for ${reject.filename}`}
                onClick={() => onDismissAttachmentError(reject.id)}
                className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-danger/70 transition hover:bg-white/[0.06] hover:text-danger active:scale-[0.96]"
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {composerError ? (
        <div
          className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in"
          role="alert"
        >
          {composerError}
        </div>
      ) : null}

      {localImageAttachments.length > 0 ? (
        <div
          className="chat-scroll-x flex min-w-0 gap-1.5 overflow-x-auto pb-0.5"
          role="list"
          aria-label="Image attachments"
        >
          {localImageAttachments.map((attachment) => {
            const raw = attachment.data ?? attachment.url ?? "";
            const src = /^(data:|blob:|https?:|file:)/i.test(raw)
              ? raw
              : `data:${attachment.mediaType ?? "image/png"};base64,${raw}`;
            return (
              <div
                key={attachment.id}
                className="relative w-24 shrink-0"
                role="listitem"
              >
                <img
                  src={src}
                  alt={attachment.name ?? "Image"}
                  className="aspect-square w-full rounded-lg border border-white/[0.08] object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name ?? "image"}`}
                  title="Remove"
                  onClick={() => composer.removeAttachment(attachment.id)}
                  className="absolute right-1 top-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-md bg-black/60 text-white/85 backdrop-blur-sm transition duration-150 hover:bg-black/75 hover:text-white active:scale-[0.92]"
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {activeContextImages.length > 0 ? (
        <div
          className="chat-scroll-x flex min-w-0 gap-1.5 overflow-x-auto pb-0.5"
          role="list"
          aria-label="Active image context"
        >
          {activeContextImages.map((image) => (
            <div key={image.id} className="w-24 shrink-0" role="listitem">
              <GeneratedImageThumbnail
                image={image}
                pinned
                onTogglePin={() => onToggleImageContext(image)}
              />
            </div>
          ))}
        </div>
      ) : null}

      {contextSnippetError ? (
        <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in">
          {contextSnippetError}
        </div>
      ) : null}

      {contextSnippet ? (
        <ContextSnippetChip
          snippet={contextSnippet}
          variant="composer"
          removing={removingContext}
          onRemove={() => {
            if (removingContext) return;
            setRemovingContext(true);
            window.setTimeout(() => {
              onRemoveContextSnippet();
              setRemovingContext(false);
            }, 180);
          }}
        />
      ) : null}

      <MessageQueueDock
        items={queuedItems}
        onSendNow={onQueueSendNow}
        onRemove={onQueueRemove}
        onReorder={onQueueReorder}
        onRecall={onQueueRecall}
        onCancelEdit={onQueueCancelEdit}
      />

      <div className="relative flex min-h-[2.75rem] flex-col pb-11">
        <ComposerPrimitive.TextareaInput
          ref={composerInputRef}
          className="composer-input min-h-[1.5rem] w-full min-w-0 flex-1 bg-transparent px-1 text-sm leading-relaxed text-text"
          data-anvia-composer-editor
          data-anvia-composer-input
          minRows={1}
          maxRows={8}
          placeholder={placeholderText}
          disabled={
            isIngesting ||
            modelsUnavailable ||
            chatStatus === "waiting"
          }
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              !active
            ) {
              return;
            }
            event.preventDefault();
            if (composerAction === "queue") {
              void submitQueueDraft();
            } else if (composerAction === "stop") {
              requestStop();
            }
          }}
        />

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <FeaturesPopover
              webSearchEnabled={webSearchEnabled}
              onWebSearchToggle={onWebSearchToggle}
              webSearchAvailable={webSearchAvailable}
              deepResearchEnabled={deepResearchEnabled}
              onDeepResearchToggle={onDeepResearchToggle}
              deepResearchAvailable={deepResearchAvailable}
              imageGenerationEnabled={imageGenerationEnabled}
              onImageGenerationToggle={onImageGenerationToggle}
              imageGenerationAvailable={imageGenerationAvailable}
              settings={imageGenSettings}
              onSettingsChange={onImageGenSettingsChange}
            />
            <ModelReasoningSwitcher
              models={models}
              reasoningEfforts={reasoningEfforts}
              model={model}
              reasoningEffort={reasoningEffort}
              disabled={busy || modelsUnavailable}
              onModelChange={onModelChange}
              onReasoningChange={onReasoningChange}
            />
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {contextUsageError ? (
              <span className="shrink-0 text-[10px] font-medium text-danger/80 animate-fade-in">
                Usage unavailable
              </span>
            ) : null}
            <ContextUsageIndicator
              models={models}
              contextUsage={contextUsage ?? null}
            />

            <ComposerAttachControl
              sessionId={sessionId}
              projectId={projectId}
              activeDocumentIds={activeDocumentIds}
              disabled={isIngesting || modelsUnavailable}
              onLinkedDocuments={onLinkedDocuments}
              onRejectedFiles={onAttachmentRejected}
            />

            {composerAction === "queue" ? (
              <button
                type="button"
                aria-label="Add to queue"
                title="Add to queue"
                aria-busy={queueSubmitting}
                disabled={
                  isIngesting ||
                  !modelsReady ||
                  onQueueSubmit === undefined ||
                  queueSubmitting
                }
                onClick={() => {
                  void submitQueueDraft();
                }}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CornerDownLeft className="size-4" strokeWidth={2.25} />
              </button>
            ) : composerAction === "stop" ? (
              <ComposerPrimitive.Stop
                aria-label="Stop"
                title="Stop"
                onClick={(event) => {
                  // The route owns the API stop + client finalization. Prevent
                  // the primitive from issuing a second chat.stop() call.
                  event.preventDefault();
                  requestStop();
                }}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-text text-canvas transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-90 active:scale-[0.96]"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </ComposerPrimitive.Stop>
            ) : composerAction === "send" ? (
              <ComposerPrimitive.Submit
                aria-label={isIngesting ? "Processing document" : "Send"}
                title={isIngesting ? "Processing document" : "Send"}
                disabled={isIngesting || !modelsReady}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </ComposerPrimitive.Submit>
            ) : (
              <button
                type="button"
                aria-label={
                  chatStatus === "waiting"
                    ? "Waiting for agent"
                    : "Send"
                }
                title={
                  chatStatus === "waiting"
                    ? "Waiting for agent"
                    : "Send"
                }
                disabled
                className="inline-flex size-9 shrink-0 cursor-not-allowed items-center justify-center rounded-xl bg-accent text-canvas opacity-40"
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
