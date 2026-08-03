import type { UseChatStatus } from "@anvia/react";
import { Composer } from "@anvia/react-ui";
import { ArrowUp, Square } from "lucide-react";
import type { RefObject } from "react";
import { ComposerAttachControl } from "#/components/composer/composer-attach-control";
import { ModelReasoningSwitcher } from "#/components/composer/model-reasoning-switcher";
import type {
  CompletionModelId,
  ReasoningEffort,
} from "#/lib/chat/models";
import type { SessionDocument } from "#/lib/api";

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
  composerInputRef,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  onLinkedDocuments,
}: {
  sessionId: string;
  projectId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
  chatStatus: UseChatStatus;
  isIngesting: boolean;
  composerError: string | null;
  composerInputRef: RefObject<HTMLDivElement | null>;
  model: CompletionModelId;
  reasoningEffort: ReasoningEffort;
  onModelChange: (model: CompletionModelId) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
  onLinkedDocuments?: (documents: SessionDocument[]) => void;
}) {
  const busy = isIngesting || chatStatus === "streaming";

  return (
    <div className="glass-composer group/composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
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
