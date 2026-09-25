import type { UseChatStatus } from "@anvia/react";
import type { UIAttachment } from "@anvia/client";
import { ComposerPrimitive, useComposer } from "@anvia/react-ui";
import type { ComposerEntity } from "@anvia/react-ui";
import { ArrowUp, CalendarClock, CornerDownLeft, FileText, FileX, Globe, Images, Link2, ListChecks, MessagesSquare, Plug, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ContextSnippetChip } from "#/components/chat/context-snippet-chip";
import { ComposerAttachControl } from "#/components/composer/composer-attach-control";
import { ContextUsageIndicator } from "#/components/composer/context-usage-indicator";
import { FeaturesPopover, type FeatureCountSummary } from "#/components/composer/features-popover";
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
import {
  formatPinnedArtifactRef,
  mergePinnedEntitiesText,
  parsePinnedArtifactRefs,
  stripPinnedArtifactRefs,
  type ArtifactType,
} from "#/lib/api-artifacts";
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
  skillsSummary = null,
  mcpSummary = null,
  skillsPerChatEnabled = false,
  mcpPerChatEnabled = false,
  onSkillsToggle = () => {},
  onMcpToggle = () => {},
  onOpenSkills = () => {},
  onOpenMcp = () => {},
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
  initialPinnedRefs,
  readOnly = false,
  locked = false,
  lockedLabel,
  externalError = null,
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
  /** Null while the user-enhancement catalog is loading. */
  skillsSummary?: FeatureCountSummary | null;
  mcpSummary?: FeatureCountSummary | null;
  skillsPerChatEnabled?: boolean;
  mcpPerChatEnabled?: boolean;
  onSkillsToggle?: (enabled: boolean) => void;
  onMcpToggle?: (enabled: boolean) => void;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
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
  /** Artifact pins to seed as composer entities on mount (handoff drafts). */
  initialPinnedRefs?: Array<{ type: ArtifactType; id: string; label: string }>;
  /** Frozen share view: field and controls render disabled. */
  readOnly?: boolean;
  /**
   * Deferred submit in flight (share fork): the normal field keeps its draft
   * but sends nothing until the owner swaps the room onto the fork.
   */
  locked?: boolean;
  /** Label announced on the field while locked (defaults to processing). */
  lockedLabel?: string;
  /** Owner-scoped error rendered inside the normal composer shell. */
  externalError?: { key: number; message: string } | null;
}) {
  const active = isActiveComposerStatus(chatStatus);
  const busy = isIngesting || active || locked;
  const modelsReady =
    modelsStatus === "success" &&
    models.length > 0 &&
    models.some((item) => item.modelId === model);
  const modelsUnavailable = !modelsReady || readOnly;
  // Exit animation state for the context chip: the remove action is deferred
  // ~180ms so the fade-out can play before the snippet unmounts.
  const [removingContext, setRemovingContext] = useState(false);
  // Local photo attachments (image/*) preview above the field; they are
  // uploaded as session images when the message is sent.
  const composer = useComposer();
  const [artifactPins, setArtifactPins] = useState<
    Array<{ type: ArtifactType; id: string; label: string }>
  >([]);
  const composerHasInput =
    composer.input.trim().length > 0 ||
    composer.attachments.length > 0 ||
    artifactPins.length > 0;
  /**
   * Pinned artifacts are app-owned state (chips above the field). A mirror
   * effect keeps native composer entities in sync so Anvia's own gates
   * (canSubmit, Enter-to-send) treat pins as content — Anvia wipes native
   * entities on every keystroke, so the app state is the source of truth
   * and token text merges into the message only at send time.
   */
  const pinKey = (type: string, id: string) => `${type}:${id}`;
  const addArtifactPin = useCallback(
    (ref: { type: ArtifactType; id: string; label: string }) => {
      setArtifactPins((prev) =>
        prev.some((pin) => pinKey(pin.type, pin.id) === pinKey(ref.type, ref.id))
          ? prev
          : [...prev, ref],
      );
    },
    [],
  );
  const removePinnedEntity = useCallback((type: string, id: string) => {
    setArtifactPins((prev) =>
      prev.filter((pin) => pinKey(pin.type, pin.id) !== pinKey(type, id)),
    );
  }, []);
  useEffect(() => {
    const wanted = new Set(artifactPins.map((pin) => pinKey(pin.type, pin.id)));
    const current = new Set(
      composer.entities
        .filter((entity) => entity.triggerId === "artifact")
        .map((entity) => {
          const data = entity.data as Record<string, unknown> | undefined;
          return pinKey(String(data?.artifactType ?? ""), String(data?.artifactId ?? ""));
        }),
    );
    const same =
      wanted.size === current.size && [...wanted].every((key) => current.has(key));
    if (same) return;
    composer.setEntities((prev) => [
      ...prev.filter((entity) => entity.triggerId !== "artifact"),
      ...artifactPins.map(
        (pin): ComposerEntity => ({
          id: `pin-${pinKey(pin.type, pin.id)}`,
          triggerId: "artifact",
          trigger: "@",
          label: pin.label,
          text: formatPinnedArtifactRef(pin.type, pin.id, pin.label),
          range: { from: 0, to: 0 },
          data: { artifactType: pin.type, artifactId: pin.id },
        }),
      ),
    ]);
  });
  const composerAction = composerActionForStatus(chatStatus, composerHasInput);
  const queueSubmissionInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const [queueSubmitting, setQueueSubmitting] = useState(false);
  const localImageAttachments = composer.attachments.filter(
    (attachment) => isImageAttachmentLike(attachment),
  );

  const placeholderText = locked
    ? (lockedLabel ?? "Processing…")
    : readOnly
      ? "This is a frozen shared copy — log in to continue it as your own chat."
      : active
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
      // Fold pin token text into the queued draft so every downstream path
      // (flush, recall, edit) carries the reference.
      const text = mergePinnedEntitiesText(
        composer.input,
        artifactPins.map((pin) => formatPinnedArtifactRef(pin.type, pin.id, pin.label)),
      );
      await onQueueSubmit(text, composer.attachments);
    } finally {
      queueSubmissionInFlightRef.current = false;
      setQueueSubmitting(false);
    }
  }, [composer, composerAction, onQueueSubmit, artifactPins]);

  const requestStop = useCallback(() => {
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    onStopRun?.();
  }, [onStopRun]);

  useEffect(() => {
    if (!active) stopRequestedRef.current = false;
  }, [active]);

  // Optimistic clear on send: ready/error → submitted blanks the field
  // immediately. Skip waiting → submitted/streaming so a follow-up typed
  // before an approval/clarification is not wiped when the user allows it.
  const wasActiveRef = useRef(false);
  const previousStatusRef = useRef(chatStatus);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = chatStatus;
    if (active && !wasActiveRef.current && !suppressOptimisticClear?.current) {
      if (previousStatus !== "waiting") {
        composer.setInput("");
        composer.clearAttachments();
        composer.setEntities([]);
        setArtifactPins([]);
      }
    }
    wasActiveRef.current = active;
  }, [active, chatStatus, composer, suppressOptimisticClear]);

  // Queue-item edit hydration: replace the composer contents with the item's
  // draft (text + attachments). Token references inside recalled text move
  // back into pins so the field stays clean and chips return.
  useEffect(() => {
    if (!editHydration) return;
    const rawText = editHydration.draft?.text ?? "";
    const parsed = parsePinnedArtifactRefs(rawText);
    if (parsed.length > 0) {
      setArtifactPins(
        parsed.map((ref) => ({ type: ref.type, id: ref.id, label: ref.label || ref.id })),
      );
      composer.setInput(stripPinnedArtifactRefs(rawText));
    } else {
      composer.setInput(rawText);
    }
    composer.setAttachments(editHydration.draft?.attachments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per version bump
  }, [editHydration?.version]);

  // Queue/cancel actions clear the composer outside a status transition
  // (mid-stream clear() crashes the SDK editor — use the safe primitives).
  useEffect(() => {
    if (!clearComposerSignal) return;
    composer.setInput("");
    composer.clearAttachments();
    composer.setEntities([]);
    setArtifactPins([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run per version bump
  }, [clearComposerSignal?.version]);

  // Handoff prefill (e.g. "chat about this site" from the sites browser):
  // seed pins once so pins arrive as chips, never as raw text.
  const initialPinsAppliedRef = useRef(false);
  useEffect(() => {
    if (initialPinsAppliedRef.current || !initialPinnedRefs?.length) return;
    initialPinsAppliedRef.current = true;
    for (const ref of initialPinnedRefs) addArtifactPin(ref);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per mount
  }, [initialPinnedRefs]);

  // A new snippet always starts non-removing, even if the removal timeout
  // never ran (e.g. the snippet was cleared externally).
  useEffect(() => {
    if (!contextSnippet) setRemovingContext(false);
  }, [contextSnippet]);

  return (
    <div className="glass-composer group/composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
      {!readOnly && modelsStatus === "error" ? (
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

      {externalError ? (
        <div
          key={externalError.key}
          className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in"
          role="alert"
        >
          {externalError.message}
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

      {artifactPins.length > 0 ? (
        <div
          className="flex min-w-0 flex-wrap gap-1.5"
          role="list"
          aria-label="Pinned artifacts"
        >
          {artifactPins.map((pin) => {
            const Icon =
              pin.type === "site"
                ? Globe
                : pin.type === "document"
                  ? FileText
                  : pin.type === "image"
                    ? Images
                    : pin.type === "task"
                      ? ListChecks
                      : pin.type === "schedule"
                        ? CalendarClock
                        : pin.type === "web_bundle"
                          ? Link2
                          : pin.type === "session"
                            ? MessagesSquare
                            : Plug;
            return (
              <span
                key={pinKey(pin.type, pin.id)}
                role="listitem"
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/[0.07] py-0 pl-2 pr-1 text-[11px] font-medium text-text animate-fade-in"
              >
                <Icon className="size-3 shrink-0 text-accent" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate">{pin.label}</span>
                <button
                  type="button"
                  aria-label={`Remove pinned ${pin.type} ${pin.label}`}
                  onClick={() => removePinnedEntity(pin.type, pin.id)}
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.08] hover:text-text"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      <MessageQueueDock
        items={queuedItems}
        onSendNow={onQueueSendNow}
        onRemove={onQueueRemove}
        onReorder={onQueueReorder}
        onRecall={onQueueRecall}
        onCancelEdit={onQueueCancelEdit}
      />

      <div className="relative pb-11">
        <ComposerPrimitive.TextareaInput
          ref={composerInputRef}
          className="composer-input chat-scroll block min-h-[1.625em] w-full min-w-0 resize-none bg-transparent px-1 text-sm leading-relaxed text-text"
          data-anvia-composer-editor
          data-anvia-composer-input
          minRows={1}
          maxRows={4}
          placeholder={placeholderText}
          disabled={locked || readOnly || isIngesting || modelsUnavailable || chatStatus === "waiting"}
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
              skillsSummary={skillsSummary}
              mcpSummary={mcpSummary}
              skillsPerChatEnabled={skillsPerChatEnabled}
              mcpPerChatEnabled={mcpPerChatEnabled}
              onSkillsToggle={onSkillsToggle}
              onMcpToggle={onMcpToggle}
              onOpenSkills={onOpenSkills}
              onOpenMcp={onOpenMcp}
            />
            <ModelReasoningSwitcher
              models={models}
              reasoningEfforts={reasoningEfforts}
              model={model}
              reasoningEffort={reasoningEffort}
              disabled={locked || readOnly || busy || modelsUnavailable}
              onModelChange={onModelChange}
              onReasoningChange={onReasoningChange}
            />
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <ContextUsageIndicator
              models={models}
              contextUsage={contextUsage ?? null}
            />

            <ComposerAttachControl
              sessionId={sessionId}
              projectId={projectId}
              activeDocumentIds={activeDocumentIds}
              disabled={locked || readOnly || isIngesting || modelsUnavailable}
              onLinkedDocuments={onLinkedDocuments}
              onRejectedFiles={onAttachmentRejected}
              onPinArtifact={addArtifactPin}
              onAttached={() => {
                // Defer past the dialog's native focus-restore on close,
                // otherwise focus snaps back to the menu invoker.
                requestAnimationFrame(() => {
                  composerInputRef.current?.focus();
                });
              }}
            />

            {composerAction === "queue" ? (
              <button
                type="button"
                aria-label="Add to queue"
                title="Add to queue"
                aria-busy={queueSubmitting}
                disabled={
                  locked ||
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
                disabled={locked || isIngesting || !modelsReady}
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
