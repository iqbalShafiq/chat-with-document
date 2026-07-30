import type { UseChatStatus } from "@anvia/react";
import { Composer } from "@anvia/react-ui";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { UploadingDocumentsSection } from "#/components/uploading-documents-section";
import type { DocumentStatus, SessionDocument } from "#/lib/api";
import { ArrowUp, FileText, Paperclip, Square } from "lucide-react";
import type { ComponentProps, RefObject } from "react";

type ComposerSubmit = NonNullable<
  ComponentProps<typeof Composer.Root>["submitMessage"]
>;

export function ChatComposer({
  chatStatus,
  isIngesting,
  sessionDocuments,
  ingestionItems,
  composerError,
  composerInputRef,
  submitMessage,
}: {
  chatStatus: UseChatStatus;
  isIngesting: boolean;
  sessionDocuments: SessionDocument[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
  composerError: string | null;
  composerInputRef: RefObject<HTMLDivElement | null>;
  submitMessage: ComposerSubmit;
}) {
  const busy = isIngesting || chatStatus === "streaming";

  return (
    <Composer.Root
      className="flex w-full flex-col"
      submitMessage={submitMessage}
    >
      {/* Floating glass field — thread content scrolls underneath */}
      <div className="glass-composer group/composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
        {sessionDocuments.length > 0 ? (
          <CollapsibleDocumentSection title="Active documents">
            <ul className="doc-chip-scroll flex list-none flex-nowrap gap-2 overflow-x-auto overscroll-x-contain p-0 pb-0.5">
              {sessionDocuments.map((doc) => (
                <li
                  key={doc.id}
                  className="glass-pane inline-flex min-h-10 w-max max-w-[min(280px,75vw)] shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs text-text"
                  title={doc.firstPageSummary || doc.filename}
                >
                  <FileText
                    className="size-4 shrink-0 text-accent"
                    strokeWidth={1.75}
                  />
                  <span className="truncate font-medium">{doc.filename}</span>
                </li>
              ))}
            </ul>
          </CollapsibleDocumentSection>
        ) : null}

        {composerError ? (
          <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in">
            {composerError}
          </div>
        ) : null}

        <UploadingDocumentsSection ingestionItems={ingestionItems} />

        <div className="relative flex min-h-[2.75rem] flex-col pb-10">
          <Composer.Input
            ref={composerInputRef}
            className="composer-input min-h-[1.5rem] w-full min-w-0 flex-1 bg-transparent px-1 text-sm leading-relaxed text-text"
            minRows={1}
            maxRows={8}
            placeholder="Ask about your documents…"
            disabled={isIngesting}
          />

          <div className="absolute bottom-0 right-0 flex items-center gap-1.5">
            <Composer.AddAttachment
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              multiple
              aria-label="Attach document"
              title="Attach document"
              className="glass inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/12 hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
            >
              <Paperclip className="size-4" strokeWidth={1.75} />
            </Composer.AddAttachment>

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
    </Composer.Root>
  );
}
