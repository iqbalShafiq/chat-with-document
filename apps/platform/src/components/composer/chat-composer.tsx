import type { UseChatStatus } from "@anvia/react";
import { Composer } from "@anvia/react-ui";
import { FileX, ArrowUp, Square, X } from "lucide-react";
import type { RefObject } from "react";
import { ComposerAttachControl } from "#/components/composer/composer-attach-control";
import { ModelReasoningSwitcher } from "#/components/composer/model-reasoning-switcher";
import type {
  CompletionModelId,
  ReasoningEffort,
} from "#/lib/chat/models";
import type { SessionDocument } from "#/lib/api";
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
  onLinkedDocuments,
  onAttachmentRejected,
  onDismissAttachmentError,
}: {
  sessionId: string;
  projectId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
  chatStatus: UseChatStatus;
  isIngesting: boolean;
  composerError: string | null;
  attachmentErrors: AttachmentReject[];
  composerInputRef: RefObject<HTMLDivElement | null>;
  model: CompletionModelId;
  reasoningEffort: ReasoningEffort;
  onModelChange: (model: CompletionModelId) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
  onLinkedDocuments?: (documents: SessionDocument[]) => void;
  onAttachmentRejected?: (rejects: AttachmentReject[]) => void;
  onDismissAttachmentError: (id: string) => void;
}) {
  const busy = isIngesting || chatStatus === "streaming";

  return (
    <div className="glass-composer group/composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
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

      <div className="relative flex min-h-[2.75rem] flex-col pb-11">
        <Composer.Input
          ref={composerInputRef}
          className="composer-input min-h-[1.5rem] w-full min-w-0 flex-1 bg-transparent px-1 text-sm leading-relaxed text-text"
          minRows={1}
          maxRows={8}
          placeholder="Ask about your documents…"
          disabled={isIngesting}
        />

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2">
          <ModelReasoningSwitcher
            model={model}
            reasoningEffort={reasoningEffort}
            disabled={busy}
            onModelChange={onModelChange}
            onReasoningChange={onReasoningChange}
          />

          <div className="flex shrink-0 items-center gap-1.5">
            <ComposerAttachControl
              sessionId={sessionId}
              projectId={projectId}
              activeDocumentIds={activeDocumentIds}
              disabled={busy}
              onLinkedDocuments={onLinkedDocuments}
              onRejectedFiles={onAttachmentRejected}
            />

            {chatStatus === "streaming" ? (
              <Composer.Stop
                aria-label="Stop"
                title="Stop"
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-text text-canvas transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-90 active:scale-[0.96]"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </Composer.Stop>
            ) : (
              <Composer.Submit
                aria-label={isIngesting ? "Processing document" : "Send"}
                title={isIngesting ? "Processing document" : "Send"}
                disabled={isIngesting}
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
