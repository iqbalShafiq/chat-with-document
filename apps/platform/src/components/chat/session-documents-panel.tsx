import type { UIAttachment } from "@anvia/react";
import { useComposer } from "@anvia/react-ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Focus, Globe, Quote, X } from "lucide-react";

/** Matches left desktop sidebar width. */
export const DOC_RAIL_WIDTH_PX = 272;

/** Max items shown per right-rail section before "Load more". */
const SECTION_PAGE_SIZE = 6;

/**
 * Client-side load-more for a rail section. Resets when the head of the list
 * changes (session switch / list replace) so pagination does not leak.
 */
function useSectionLoadMore<T>(items: readonly T[], getId: (item: T) => string) {
  const [visibleCount, setVisibleCount] = useState(SECTION_PAGE_SIZE);
  const headId = items.length > 0 ? getId(items[0]!) : "";
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  itemsRef.current = items;
  getIdRef.current = getId;

  useEffect(() => {
    setVisibleCount(SECTION_PAGE_SIZE);
  }, [headId]);

  const visibleItems = items.slice(0, visibleCount);
  const hasMore = visibleCount < items.length;
  const remaining = Math.max(0, items.length - visibleCount);
  const loadMore = useCallback(() => {
    setVisibleCount((current) => current + SECTION_PAGE_SIZE);
  }, []);
  /** Expand the window far enough that `id` is mounted (e.g. citation focus). */
  const ensureVisible = useCallback((id: string) => {
    const index = itemsRef.current.findIndex(
      (item) => getIdRef.current(item) === id,
    );
    if (index < 0) return;
    setVisibleCount((current) => Math.max(current, index + 1));
  }, []);

  return { visibleItems, hasMore, remaining, loadMore, ensureVisible };
}

function LoadMoreButton({
  remaining,
  onClick,
}: {
  remaining: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 w-full cursor-pointer rounded-lg py-1.5 text-center text-[11px] font-medium text-text-faint transition hover:bg-white/[0.04] hover:text-text-muted active:scale-[0.99]"
    >
      Load more
      {remaining > 0 ? (
        <span className="text-text-faint/70"> · {remaining} left</span>
      ) : null}
    </button>
  );
}

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
  const pendingItems: Array<
    | { kind: "ingestion"; item: IngestionItem }
    | { kind: "attachment"; item: UIAttachment }
  > = hasIngestion
    ? ingestionItems.map((item) => ({ kind: "ingestion" as const, item }))
    : composer.attachments.map((item) => ({
        kind: "attachment" as const,
        item,
      }));
  const pendingCount = pendingItems.length;
  const [removeError, setRemoveError] = useState<string | null>(null);

  const activePage = useSectionLoadMore(sessionDocuments, (doc) => doc.id);
  const citedPage = useSectionLoadMore(
    citedDocuments,
    (doc) => doc.documentId,
  );
  const webPage = useSectionLoadMore(webSources, (source) => source.url);
  const imagesPage = useSectionLoadMore(generatedImages, (image) => image.id);
  const contextPage = useSectionLoadMore(
    activeContextImages,
    (image) => image.id,
  );
  const pendingPage = useSectionLoadMore(pendingItems, (entry) => entry.item.id);

  // Expand pagination so a cited document past the first page is mounted.
  useEffect(() => {
    if (!focusTarget?.documentId) return;
    activePage.ensureVisible(focusTarget.documentId);
    citedPage.ensureVisible(focusTarget.documentId);
  }, [
    focusTarget?.documentId,
    focusTarget?.nonce,
    activePage.ensureVisible,
    citedPage.ensureVisible,
  ]);

  // Scroll + pulse the focused document once it is in the DOM.
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
  }, [
    focusTarget?.documentId,
    focusTarget?.nonce,
    activePage.visibleItems.length,
    citedPage.visibleItems.length,
  ]);

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
                {activePage.visibleItems.map((doc) => {
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
              {activePage.hasMore ? (
                <LoadMoreButton
                  remaining={activePage.remaining}
                  onClick={activePage.loadMore}
                />
              ) : null}
            </CollapsibleDocumentSection>
          ) : null}

          {hasCited ? (
            <CollapsibleDocumentSection title="Cited documents">
              <ul
                ref={citedListRef}
                className="flex w-full list-none flex-col gap-1.5 p-0"
              >
                {citedPage.visibleItems.map((doc) => {
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
              {citedPage.hasMore ? (
                <LoadMoreButton
                  remaining={citedPage.remaining}
                  onClick={citedPage.loadMore}
                />
              ) : null}
            </CollapsibleDocumentSection>
          ) : null}

          {hasWebSources ? (
            <CollapsibleDocumentSection title="Web sources">
              <ul className="flex w-full list-none flex-col gap-1.5 p-0">
                {webPage.visibleItems.map((source) => {
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
              {webPage.hasMore ? (
                <LoadMoreButton
                  remaining={webPage.remaining}
                  onClick={webPage.loadMore}
                />
              ) : null}
            </CollapsibleDocumentSection>
          ) : null}

          {hasGeneratedImages || runningImageCount > 0 ? (
            <CollapsibleDocumentSection title="Images">
              <ul className="grid w-full list-none grid-cols-2 gap-1.5 p-0">
                {imagesPage.visibleItems.map((image) => (
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
                {/* Always surface in-flight skeletons so generation stays visible. */}
                {Array.from({ length: runningImageCount }).map((_, i) => (
                  <li key={`running-${i}`} aria-hidden className="min-w-0">
                    <div
                      className="skeleton-shimmer aspect-square w-full rounded-lg"
                      title="Generating…"
                    />
                  </li>
                ))}
              </ul>
              {imagesPage.hasMore ? (
                <LoadMoreButton
                  remaining={imagesPage.remaining}
                  onClick={imagesPage.loadMore}
                />
              ) : null}
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
                {contextPage.visibleItems.map((image) => (
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
              {contextPage.hasMore ? (
                <LoadMoreButton
                  remaining={contextPage.remaining}
                  onClick={contextPage.loadMore}
                />
              ) : null}
            </CollapsibleDocumentSection>
          ) : null}

          {hasPending ? (
            <CollapsibleDocumentSection
              title={hasIngestion ? "Uploading documents" : "Attachments"}
            >
              <div className="flex w-full flex-col gap-1.5">
                {pendingPage.visibleItems.map((entry) =>
                  entry.kind === "ingestion" ? (
                    <IngestionStatusPill
                      key={entry.item.id}
                      filename={entry.item.filename}
                      status={entry.item.status}
                    />
                  ) : (
                    <ComposerAttachmentChip
                      key={entry.item.id}
                      attachment={entry.item}
                    />
                  ),
                )}
              </div>
              {pendingPage.hasMore ? (
                <LoadMoreButton
                  remaining={pendingPage.remaining}
                  onClick={pendingPage.loadMore}
                />
              ) : null}
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
