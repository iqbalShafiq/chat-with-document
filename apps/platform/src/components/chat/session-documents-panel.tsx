import type { UIAttachment } from "@anvia/react";
import { Composer, useComposer } from "@anvia/react-ui";
import { useEffect, useRef, useState } from "react";
import { useCitationSessionOptional } from "#/components/chat/citation-session-context";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { ComposerAttachmentChip } from "#/components/composer-attachment";
import { DocumentRow } from "#/components/documents/document-row";
import { GeneratedImageThumbnail } from "#/components/images/generated-image-thumbnail";
import { IngestionStatusPill } from "#/components/ingestion-status-pill";
import type { CitedDocumentSummary } from "#/lib/documents/cited-documents";
import type { WebSourceSummary } from "#/lib/chat/web-sources";
import type { GeneratedImageItem } from "#/lib/chat/generated-images";
import type { DocumentStatus, SessionDocument } from "#/lib/api";
import { Focus, Globe, Image, Quote, X } from "lucide-react";

/** Matches left desktop sidebar width. */
export const DOC_RAIL_WIDTH_PX = 272;

export type IngestionItem = {
  id: string;
  filename: string;
  status: DocumentStatus;
};

export function useHasSessionDocuments({
  sessionDocuments,
  citedDocuments,
  ingestionItems,
  webSources = [],
  generatedImages = [],
  runningImageCount = 0,
  activeContextImages = [],
}: {
  sessionDocuments: SessionDocument[];
  citedDocuments: CitedDocumentSummary[];
  ingestionItems: IngestionItem[];
  webSources?: WebSourceSummary[];
  generatedImages?: GeneratedImageItem[];
  runningImageCount?: number;
  activeContextImages?: GeneratedImageItem[];
}) {
  const composer = useComposer();
  return (
    sessionDocuments.length > 0 ||
    citedDocuments.length > 0 ||
    ingestionItems.length > 0 ||
    webSources.length > 0 ||
    generatedImages.length > 0 ||
    runningImageCount > 0 ||
    activeContextImages.length > 0 ||
    composer.attachments.length > 0
  );
}

/**
 * Right-rail document list: Active, Cited, Attachments (queued / processing).
 * Width matches left sidebar (272px). Parent should animate open/close width.
 */
export function SessionDocumentsPanel({
  sessionDocuments,
  citedDocuments,
  ingestionItems,
  webSources = [],
  generatedImages = [],
  runningImageCount = 0,
  activeContextImages = [],
  onRemoveActiveDocument,
  removingDocumentId = null,
  onToggleImageContext,
}: {
  sessionDocuments: SessionDocument[];
  citedDocuments: CitedDocumentSummary[];
  ingestionItems: IngestionItem[];
  webSources?: WebSourceSummary[];
  generatedImages?: GeneratedImageItem[];
  runningImageCount?: number;
  activeContextImages?: GeneratedImageItem[];
  onRemoveActiveDocument?: (documentId: string) => void;
  removingDocumentId?: string | null;
  onToggleImageContext?: (image: GeneratedImageItem) => void;
}) {
  const composer = useComposer();
  const citationSession = useCitationSessionOptional();
  const focusTarget = citationSession?.focusTarget ?? null;
  const openDocumentPreview = citationSession?.openDocumentPreview;
  const listRef = useRef<HTMLUListElement>(null);
  const citedListRef = useRef<HTMLUListElement>(null);
  const hasActive = sessionDocuments.length > 0;
  const hasCited = citedDocuments.length > 0;
  const hasWebSources = webSources.length > 0;
  const hasGeneratedImages = generatedImages.length > 0;
  const hasIngestion = ingestionItems.length > 0;
  const hasAttachments = composer.attachments.length > 0;
  const hasPending = hasIngestion || hasAttachments;
  const activeContextIds = new Set(activeContextImages.map((image) => image.id));
  const pendingCount = hasIngestion
    ? ingestionItems.length
    : composer.attachments.length;
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
            hasWebSources ? `${webSources.length} web` : null,
            hasGeneratedImages
              ? `${generatedImages.length} image${generatedImages.length === 1 ? "" : "s"}`
              : null,
            hasPending ? `${pendingCount} pending` : null,
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

          {hasWebSources ? (
            <CollapsibleDocumentSection title="Web sources">
              <ul className="flex w-full list-none flex-col gap-1.5 p-0">
                {webSources.map((source) => {
                  const domain = safeHostname(source.url);
                  return (
                    <li key={source.url} className="w-full min-w-0">
                      <DocumentRow
                        filename={source.title || source.url}
                        summary={source.content}
                        meta={domain ?? null}
                        title={`Open ${source.url} in a new tab`}
                        onClick={() => {
                          window.open(source.url, "_blank", "noopener,noreferrer");
                        }}
                        leading={
                          <Globe
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

          {hasGeneratedImages || runningImageCount > 0 ? (
            <CollapsibleDocumentSection
              title="Generated images"
              icon={
                <Image
                  className="size-3.5 shrink-0 text-accent"
                  strokeWidth={1.75}
                />
              }
            >
              <ul className="grid w-full list-none grid-cols-2 gap-1.5 p-0">
                {generatedImages.map((image) => (
                  <li key={image.id} className="min-w-0">
                    <GeneratedImageThumbnail
                      image={image}
                      pinned={activeContextIds.has(image.id)}
                      onTogglePin={
                        onToggleImageContext
                          ? () => onToggleImageContext(image)
                          : undefined
                      }
                    />
                  </li>
                ))}
                {Array.from({ length: runningImageCount }).map((_, i) => (
                  <li key={`running-${i}`} aria-hidden className="min-w-0">
                    <div
                      className="skeleton-shimmer aspect-square w-full rounded-lg"
                      title="Generating…"
                    />
                  </li>
                ))}
              </ul>
            </CollapsibleDocumentSection>
          ) : null}

          {activeContextImages.length > 0 ? (
            <CollapsibleDocumentSection
              title="Active image context"
              icon={
                <Focus
                  className="size-3.5 shrink-0 text-accent"
                  strokeWidth={1.75}
                />
              }
            >
              <p className="mb-1.5 text-[11px] leading-snug text-text-faint">
                These images are sent to the model as context — they take
                priority over other session images.
              </p>
              <ul className="grid w-full list-none grid-cols-2 gap-1.5 p-0">
                {activeContextImages.map((image) => (
                  <li key={image.id} className="min-w-0">
                    <GeneratedImageThumbnail
                      image={image}
                      pinned
                      onTogglePin={
                        onToggleImageContext
                          ? () => onToggleImageContext(image)
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </CollapsibleDocumentSection>
          ) : null}

          {hasPending ? (
            <CollapsibleDocumentSection
              title={hasIngestion ? "Uploading documents" : "Attachments"}
            >
              <div className="flex w-full flex-col gap-1.5">
                {/* After submit: show server-side ingest progress. */}
                {hasIngestion
                  ? ingestionItems.map((item) => (
                      <IngestionStatusPill
                        key={item.id}
                        filename={item.filename}
                        status={item.status}
                      />
                    ))
                  : null}

                {/* Before submit: queued local files (composer.attachments). */}
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

          {!hasActive &&
          !hasCited &&
          !hasWebSources &&
          !hasGeneratedImages &&
          runningImageCount === 0 &&
          !hasPending ? (
            <p className="px-1 py-6 text-center text-[11px] text-text-faint">
              Attach a file or pick from your library to ground this chat.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
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
  webSources = [],
  generatedImages = [],
  runningImageCount = 0,
  activeContextImages = [],
  onRemoveActiveDocument,
  removingDocumentId,
  onToggleImageContext,
}: {
  sessionDocuments: SessionDocument[];
  citedDocuments: CitedDocumentSummary[];
  ingestionItems: IngestionItem[];
  webSources?: WebSourceSummary[];
  generatedImages?: GeneratedImageItem[];
  runningImageCount?: number;
  activeContextImages?: GeneratedImageItem[];
  onRemoveActiveDocument?: (documentId: string) => void;
  removingDocumentId?: string | null;
  onToggleImageContext?: (image: GeneratedImageItem) => void;
}) {
  const open = useHasSessionDocuments({
    sessionDocuments,
    citedDocuments,
    ingestionItems,
    webSources,
    generatedImages,
    runningImageCount,
    activeContextImages,
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
            webSources={webSources}
            generatedImages={generatedImages}
            runningImageCount={runningImageCount}
            activeContextImages={activeContextImages}
            onRemoveActiveDocument={onRemoveActiveDocument}
            removingDocumentId={removingDocumentId}
            onToggleImageContext={onToggleImageContext}
          />
        </div>
      </div>
    </div>
  );
}
