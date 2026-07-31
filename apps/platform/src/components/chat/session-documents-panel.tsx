import type { UIAttachment } from "@anvia/react";
import { Composer, useComposer } from "@anvia/react-ui";
import { useEffect, useRef } from "react";
import { useCitationSessionOptional } from "#/components/chat/citation-session-context";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { ComposerAttachmentChip } from "#/components/composer-attachment";
import { IngestionStatusPill } from "#/components/ingestion-status-pill";
import type { DocumentStatus, SessionDocument } from "#/lib/api";
import { formatCitationPageLabel } from "#/lib/chat/citations";
import { FileText } from "lucide-react";

/** Matches left desktop sidebar width. */
export const DOC_RAIL_WIDTH_PX = 272;

export function useHasSessionDocuments({
  sessionDocuments,
  ingestionItems,
}: {
  sessionDocuments: SessionDocument[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
}) {
  const composer = useComposer();
  return (
    sessionDocuments.length > 0 ||
    ingestionItems.length > 0 ||
    composer.attachments.length > 0
  );
}

/**
 * Right-rail document list: Active documents + Attachments.
 * Width matches left sidebar (272px). Parent should animate open/close width.
 */
export function SessionDocumentsPanel({
  sessionDocuments,
  ingestionItems,
}: {
  sessionDocuments: SessionDocument[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
}) {
  const composer = useComposer();
  const citationSession = useCitationSessionOptional();
  const focusTarget = citationSession?.focusTarget ?? null;
  const listRef = useRef<HTMLUListElement>(null);
  const hasActive = sessionDocuments.length > 0;
  const hasIngestion = ingestionItems.length > 0;
  const hasAttachments = composer.attachments.length > 0;
  const hasPending = hasIngestion || hasAttachments;

  // Scroll + pulse the focused document when a citation is clicked.
  useEffect(() => {
    if (!focusTarget?.documentId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-document-id="${CSS.escape(focusTarget.documentId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusTarget?.documentId, focusTarget?.nonce]);

  return (
    <aside
      className="flex h-full w-full flex-col bg-transparent"
      aria-label="Session documents"
    >
      <div className="flex h-14 shrink-0 flex-col justify-center px-3">
        <p className="truncate text-sm font-semibold tracking-tight text-text">
          Documents
        </p>
        <p className="truncate text-[11px] text-text-faint">
          {[
            hasActive ? `${sessionDocuments.length} active` : null,
            hasPending
              ? `${ingestionItems.length || composer.attachments.length} pending`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || "None yet"}
        </p>
      </div>

      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3">
        <div className="flex w-full flex-col gap-4">
          {hasActive ? (
            <CollapsibleDocumentSection title="Active documents">
              <ul
                ref={listRef}
                className="flex w-full list-none flex-col gap-1.5 p-0"
              >
                {sessionDocuments.map((doc) => {
                  const focused = focusTarget?.documentId === doc.id;
                  const pageLabel = focused
                    ? formatCitationPageLabel(focusTarget?.pageIndex)
                    : null;

                  return (
                    <li
                      key={doc.id}
                      data-document-id={doc.id}
                      className="w-full min-w-0"
                    >
                      <div
                        className={[
                          "glass-pane flex w-full min-w-0 items-start gap-2.5 rounded-xl px-3 py-2.5 text-xs text-text",
                          "transition-[box-shadow,background-color] duration-300",
                          focused
                            ? "bg-accent-soft/40 ring-2 ring-accent-ring shadow-[0_0_0_1px_rgba(232,163,23,0.2)]"
                            : "",
                        ].join(" ")}
                        title={doc.firstPageSummary || doc.filename}
                      >
                        <FileText
                          className="mt-0.5 size-4 shrink-0 text-accent"
                          strokeWidth={1.75}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-start gap-2">
                            <p className="min-w-0 flex-1 truncate font-medium leading-snug">
                              {doc.filename}
                            </p>
                            {pageLabel ? (
                              <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-accent ring-1 ring-accent-ring/40">
                                {pageLabel}
                              </span>
                            ) : null}
                          </div>
                          {focused && focusTarget?.citationId != null ? (
                            <p className="mt-0.5 text-[10px] text-accent">
                              Cited as [{focusTarget.citationId}]
                            </p>
                          ) : null}
                          {doc.firstPageSummary ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-faint">
                              {doc.firstPageSummary}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleDocumentSection>
          ) : null}

          {hasPending ? (
            <CollapsibleDocumentSection title="Attachments">
              <div className="flex w-full flex-col gap-1.5">
                {hasIngestion
                  ? ingestionItems.map((item) => (
                      <IngestionStatusPill
                        key={`ingest-${item.filename}-${item.status}`}
                        filename={item.filename}
                        status={item.status}
                      />
                    ))
                  : null}

                {!hasIngestion && hasAttachments ? (
                  <Composer.Attachments
                    keepMounted
                    className="flex w-full flex-col gap-1.5"
                  >
                    {(attachment: UIAttachment) => (
                      <ComposerAttachmentChip
                        key={attachment.id}
                        attachment={attachment}
                      />
                    )}
                  </Composer.Attachments>
                ) : null}
              </div>
            </CollapsibleDocumentSection>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/**
 * Animated 272px rail — collapses to 0 when no docs/attachments. Desktop only.
 * Floating list uses the same vertical insets as the chat scrollbar track:
 *   top = top bar + 24px, bottom = textfield dock + --chat-composer-gap.
 */
export function SessionDocumentsRail({
  sessionDocuments,
  ingestionItems,
}: {
  sessionDocuments: SessionDocument[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
}) {
  const open = useHasSessionDocuments({ sessionDocuments, ingestionItems });

  return (
    <div
      className={`hidden shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:block ${
        open
          ? "w-[272px] translate-x-0 opacity-100"
          : "w-0 translate-x-1 opacity-0 pointer-events-none"
      }`}
    >
      <div className="relative h-full pr-2" style={{ width: DOC_RAIL_WIDTH_PX }}>
        <div
          className="absolute inset-x-0 min-h-0 overflow-hidden pr-2"
          style={{
            top: "calc(3.5rem + 24px)",
            bottom:
              "calc(var(--composer-dock-h, 7.5rem) + var(--chat-composer-gap, 40px))",
          }}
        >
          <SessionDocumentsPanel
            sessionDocuments={sessionDocuments}
            ingestionItems={ingestionItems}
          />
        </div>
      </div>
    </div>
  );
}
