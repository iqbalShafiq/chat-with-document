import type { UIAttachment } from "@anvia/react";
import { Composer, useComposer } from "@anvia/react-ui";
import { useEffect, useRef, useState } from "react";
import { useCitationSessionOptional } from "#/components/chat/citation-session-context";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { ComposerAttachmentChip } from "#/components/composer-attachment";
import { DocumentRow } from "#/components/documents/document-row";
import { IngestionStatusPill } from "#/components/ingestion-status-pill";
import type { CitedDocumentSummary } from "#/lib/documents/cited-documents";
import type { DocumentStatus, SessionDocument } from "#/lib/api";
import { Quote, X } from "lucide-react";

/** Matches left desktop sidebar width. */
export const DOC_RAIL_WIDTH_PX = 272;

export function useHasSessionDocuments({
  sessionDocuments,
  citedDocuments,
  ingestionItems,
}: {
  sessionDocuments: SessionDocument[];
  citedDocuments: CitedDocumentSummary[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
}) {
  const composer = useComposer();
  return (
    sessionDocuments.length > 0 ||
    citedDocuments.length > 0 ||
    ingestionItems.length > 0 ||
    composer.attachments.length > 0
  );
}

/**
 * Right-rail document list: Active, Cited, Attachments.
 * Width matches left sidebar (272px). Parent should animate open/close width.
 */
export function SessionDocumentsPanel({
  sessionDocuments,
  citedDocuments,
  ingestionItems,
  onRemoveActiveDocument,
  removingDocumentId = null,
}: {
  sessionDocuments: SessionDocument[];
  citedDocuments: CitedDocumentSummary[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
  onRemoveActiveDocument?: (documentId: string) => void;
  removingDocumentId?: string | null;
}) {
  const composer = useComposer();
  const citationSession = useCitationSessionOptional();
  const focusTarget = citationSession?.focusTarget ?? null;
  const openDocumentPreview = citationSession?.openDocumentPreview;
  const listRef = useRef<HTMLUListElement>(null);
  const citedListRef = useRef<HTMLUListElement>(null);
  const hasActive = sessionDocuments.length > 0;
  const hasCited = citedDocuments.length > 0;
  const hasIngestion = ingestionItems.length > 0;
  const hasAttachments = composer.attachments.length > 0;
  const hasPending = hasIngestion || hasAttachments;
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Scroll + pulse the focused document when a citation is clicked.
  useEffect(() => {
    if (!focusTarget?.documentId) return;
    const id = CSS.escape(focusTarget.documentId);
    const el =
      listRef.current?.querySelector<HTMLElement>(
        `[data-document-id="${id}"]`,
      ) ??
      citedListRef.current?.querySelector<HTMLElement>(
        `[data-document-id="${id}"]`,
      );
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusTarget?.documentId, focusTarget?.nonce]);

  useEffect(() => {
    setRemoveError(null);
  }, [sessionDocuments]);

  const handleRemove = async (documentId: string) => {
    if (!onRemoveActiveDocument) return;
    setRemoveError(null);
    try {
      await onRemoveActiveDocument(documentId);
    } catch (error) {
      setRemoveError(
        error instanceof Error
          ? error.message
          : "Could not remove document from session",
      );
    }
  };

  const openPreview = (input: {
    documentId: string;
    filename: string;
    pageIndex?: number;
    firstPageSummary?: string;
    sizeBytes?: number;
    mimeType?: string;
    pageCount?: number;
  }) => {
    if (!openDocumentPreview) return;
    // Sidebar/list opens are plain previews — clear citation focus chrome.
    citationSession?.clearDocumentFocus();
    openDocumentPreview({
      documentId: input.documentId,
      filename: input.filename,
      ...(typeof input.pageIndex === "number"
        ? { pageIndex: input.pageIndex }
        : {}),
      ...(input.firstPageSummary
        ? { firstPageSummary: input.firstPageSummary }
        : {}),
      ...(typeof input.sizeBytes === "number"
        ? { sizeBytes: input.sizeBytes }
        : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(typeof input.pageCount === "number"
        ? { pageCount: input.pageCount }
        : {}),
    });
  };

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
            hasCited ? `${citedDocuments.length} cited` : null,
            hasPending
              ? `${ingestionItems.length || composer.attachments.length} pending`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || "None yet"}
        </p>
      </div>

      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3">
        <div className="flex w-full flex-col gap-2">
          {removeError ? (
            <p className="px-0.5 text-[11px] text-danger" role="alert">
              {removeError}
            </p>
          ) : null}

          {hasActive ? (
            <CollapsibleDocumentSection title="Active documents">
              <ul
                ref={listRef}
                className="flex w-full list-none flex-col gap-1.5 p-0"
              >
                {sessionDocuments.map((doc) => {
                  const removing = removingDocumentId === doc.id;

                  return (
                    <li
                      key={doc.id}
                      data-document-id={doc.id}
                      className="w-full min-w-0"
                    >
                      <DocumentRow
                        filename={doc.filename}
                        summary={doc.firstPageSummary}
                        data-document-id={doc.id}
                        title={`Preview ${doc.filename}`}
                        onClick={() =>
                          openPreview({
                            documentId: doc.id,
                            filename: doc.filename,
                            firstPageSummary: doc.firstPageSummary,
                            sizeBytes: doc.sizeBytes,
                            mimeType: doc.mimeType,
                            pageCount: doc.pageCount,
                          })
                        }
                        trailing={
                          onRemoveActiveDocument ? (
                            <button
                              type="button"
                              aria-label={`Remove ${doc.filename} from this chat`}
                              title="Remove from this chat (keeps your library copy)"
                              disabled={removing}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleRemove(doc.id);
                              }}
                              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-white/[0.06] hover:text-text disabled:cursor-default disabled:opacity-40"
                            >
                              <X className="size-3.5" strokeWidth={2} />
                            </button>
                          ) : null
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </CollapsibleDocumentSection>
          ) : null}

          {hasCited ? (
            <CollapsibleDocumentSection title="Cited documents">
              <ul
                ref={citedListRef}
                className="flex w-full list-none flex-col gap-1.5 p-0"
              >
                {citedDocuments.map((doc) => {
                  const inActive = sessionDocuments.find(
                    (d) => d.id === doc.documentId,
                  );
                  return (
                    <li
                      key={doc.documentId}
                      data-document-id={doc.documentId}
                      className="w-full min-w-0"
                    >
                      <DocumentRow
                        filename={doc.filename}
                        data-document-id={doc.documentId}
                        title={`Preview ${doc.filename}`}
                        onClick={() =>
                          openPreview({
                            documentId: doc.documentId,
                            filename: doc.filename,
                            firstPageSummary: inActive?.firstPageSummary,
                            sizeBytes: inActive?.sizeBytes,
                            mimeType: inActive?.mimeType,
                            pageCount: inActive?.pageCount,
                          })
                        }
                        meta={[
                          `${doc.citationCount} citation${doc.citationCount === 1 ? "" : "s"}`,
                          inActive ? null : "Not in active set",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        leading={
                          <Quote
                            className="mt-0.5 size-4 shrink-0 text-accent"
                            strokeWidth={1.75}
                          />
                        }
                      />
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

          {!hasActive && !hasCited && !hasPending ? (
            <p className="px-1 py-6 text-center text-[11px] text-text-faint">
              Attach a file or pick from your library to ground this chat.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/**
 * Animated 272px rail — collapses to 0 when no docs/attachments. Desktop only.
 * Sits under the absolute top app bar (h-14) and runs full height to the
 * bottom of the viewport (not cut off above the composer).
 */
export function SessionDocumentsRail({
  sessionDocuments,
  citedDocuments,
  ingestionItems,
  onRemoveActiveDocument,
  removingDocumentId,
}: {
  sessionDocuments: SessionDocument[];
  citedDocuments: CitedDocumentSummary[];
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
  onRemoveActiveDocument?: (documentId: string) => void;
  removingDocumentId?: string | null;
}) {
  const open = useHasSessionDocuments({
    sessionDocuments,
    citedDocuments,
    ingestionItems,
  });

  return (
    <div
      className={`hidden h-full min-h-0 shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:block ${
        open
          ? "w-[272px] translate-x-0 opacity-100"
          : "w-0 translate-x-1 opacity-0 pointer-events-none"
      }`}
    >
      <div className="relative h-full" style={{ width: DOC_RAIL_WIDTH_PX }}>
        {/*
          Top bar is position:absolute over the main column.
          Anchor under the bar with top-24, stretch to the bottom edge.
        */}
        <div className="absolute inset-x-0 bottom-0 top-17 flex min-h-0 flex-col overflow-hidden">
          <SessionDocumentsPanel
            sessionDocuments={sessionDocuments}
            citedDocuments={citedDocuments}
            ingestionItems={ingestionItems}
            onRemoveActiveDocument={onRemoveActiveDocument}
            removingDocumentId={removingDocumentId}
          />
        </div>
      </div>
    </div>
  );
}
