import type { UseChatStatus } from "@anvia/react";
import { Composer, useComposer } from "@anvia/react-ui";
import { FileX, ArrowUp, Square, X } from "lucide-react";
import { useEffect, type RefObject } from "react";
import { ComposerAttachControl } from "#/components/composer/composer-attach-control";
import { ContextUsageIndicator } from "#/components/composer/context-usage-indicator";
import { FeaturesPopover } from "#/components/composer/features-popover";
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
import type { AttachmentReject } from "#/lib/documents/upload-file";

/** 3 cards × 2.5rem + 2 gaps × 0.375rem — taller stacks scroll. */
const ATTACHMENT_ERRORS_MAX_HEIGHT = "max-h-[8.25rem]";

/**
 * Input shell only — must sit inside Composer.Root.
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
  onLinkedDocuments,
  onAttachmentRejected,
  onDismissAttachmentError,
  models = [],
  reasoningEfforts = [],
  modelsStatus = "loading",
  modelsError = null,
  onRetryModels = () => {},
  compaction = { phase: "idle" },
  contextUsage = null,
  contextUsageError = false,
  webSearchEnabled = false,
  webSearchAvailable = true,
  onWebSearchToggle = () => {},
  imageGenerationEnabled = false,
  imageGenerationAvailable = true,
  onImageGenerationToggle = () => {},
  imageGenSettings = {},
  onImageGenSettingsChange = () => {},
  activeContextImages = [],
  onToggleImageContext = () => {},
}: {
  sessionId: string;
  projectId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
  chatStatus: UseChatStatus;
  isIngesting: boolean;
  composerError: string | null;
  attachmentErrors: AttachmentReject[];
  composerInputRef: RefObject<HTMLDivElement | null>;
  model: string;
  reasoningEffort: string | null;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string | null) => void;
  /** Wired in routes/index.tsx — stops the run server-side (worker stop flag). */
  onStopRun?: () => void;
  onLinkedDocuments?: (documents: SessionDocument[]) => void;
  onAttachmentRejected?: (rejects: AttachmentReject[]) => void;
  onDismissAttachmentError: (id: string) => void;
  models?: ModelInfo[];
  reasoningEfforts?: ReasoningEffortInfo[];
  modelsStatus?: "loading" | "success" | "error";
  modelsError?: string | null;
  onRetryModels?: () => void;
  /** Wired in Task 14 — declared now so `routes/index.tsx` can pass them. */
  compaction?: { phase: "idle" | "start" | "complete" | "error" };
  contextUsage?: ContextUsageInfo | null;
  /** Latest context-usage refresh failed (ring shows a transient hint). */
  contextUsageError?: boolean;
  /** Per-session web-search toggle state (default off). */
  webSearchEnabled?: boolean;
  /** Server has web tools configured (TAVILY_API_KEY). */
  webSearchAvailable?: boolean;
  onWebSearchToggle?: (enabled: boolean) => void;
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
  /** Wired in Task 9 — declared now so routes/index.tsx can pass them. */
  contextSnippet?: ContextSnippet | null;
  contextSnippetError?: string | null;
  onRemoveContextSnippet?: () => void;
}) {
  const busy = isIngesting || chatStatus === "streaming";
  const modelsReady = modelsStatus === "success" && models.length > 0;
  const modelsUnavailable = modelsStatus !== "success";
  // Local photo attachments (image/*) preview above the field; they are
  // uploaded as session images when the message is sent.
  const composer = useComposer();
  const localImageAttachments = composer.attachments.filter(
    (attachment) => isImageAttachmentLike(attachment),
  );

  const placeholderText =
    chatStatus === "streaming"
      ? "The agent is generating…"
      : isIngesting
        ? "Processing document…"
        : "Ask about your documents…";

  // Optimistic clear: when a stream starts, empty the composer (text +
  // image attachments) right away. Only input + attachments are touched —
  // the full SDK clear() (entities, triggers) runs post-stream where the
  // ComposerInput editor is stable.
  useEffect(() => {
    if (chatStatus !== "streaming") return;
    composer.setInput("");
    composer.clearAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per stream start
  }, [chatStatus]);

  // @anvia/react-ui's useEditor does not re-apply the Placeholder extension
  // when the prop changes, and Tiptap may recreate the empty <p> on clears.
  // Patch data-placeholder only when status changes — never via MutationObserver
  // on that attribute (setAttribute ↔ Tiptap decoration ping-pongs and freezes
  // the main thread).
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20;

    const apply = () => {
      if (cancelled) return true;
      const editorEl = document.querySelector<HTMLElement>(
        "[data-anvia-composer-editor]",
      );
      const p = editorEl?.querySelector("p[data-placeholder]");
      if (!p) return false;
      if (p.getAttribute("data-placeholder") !== placeholderText) {
        p.setAttribute("data-placeholder", placeholderText);
      }
      return true;
    };

    if (apply()) return;

    // Editor can mount a frame later (Composer.Input). Retry briefly; do not
    // observe mutations — that re-introduced a CPU spin with Tiptap.
    const timer = window.setInterval(() => {
      attempts += 1;
      if (apply() || attempts >= maxAttempts) {
        window.clearInterval(timer);
      }
    }, 50);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [placeholderText]);

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
        <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in">
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

      <div className="relative flex min-h-[2.75rem] flex-col pb-11">
        <Composer.Input
          ref={composerInputRef}
          className="composer-input min-h-[1.5rem] w-full min-w-0 flex-1 bg-transparent px-1 text-sm leading-relaxed text-text"
          minRows={1}
          maxRows={8}
          placeholder={placeholderText}
          disabled={isIngesting || modelsUnavailable}
        />

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <FeaturesPopover
              webSearchEnabled={webSearchEnabled}
              onWebSearchToggle={onWebSearchToggle}
              webSearchAvailable={webSearchAvailable}
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
              compaction={compaction ?? { phase: "idle" }}
            />

            <ComposerAttachControl
              sessionId={sessionId}
              projectId={projectId}
              activeDocumentIds={activeDocumentIds}
              disabled={busy || modelsUnavailable}
              onLinkedDocuments={onLinkedDocuments}
              onRejectedFiles={onAttachmentRejected}
            />

            {chatStatus === "streaming" ? (
              <Composer.Stop
                aria-label="Stop"
                title="Stop"
                onClick={onStopRun}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-text text-canvas transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-90 active:scale-[0.96]"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </Composer.Stop>
            ) : (
              <Composer.Submit
                aria-label={isIngesting ? "Processing document" : "Send"}
                title={isIngesting ? "Processing document" : "Send"}
                disabled={isIngesting || !modelsReady}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </Composer.Submit>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
