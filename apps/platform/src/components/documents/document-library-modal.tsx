import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eye, Search } from "lucide-react";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";
import { DialogShell } from "#/components/ui/dialog-shell";
import { DocumentPreviewPane } from "#/components/documents/document-preview-pane";
import { DocumentRow } from "#/components/documents/document-row";
import { useDebouncedValue } from "#/hooks/use-debounced-value";
import { useInfiniteScrollSentinel } from "#/hooks/use-infinite-scroll-sentinel";
import {
  listUserDocuments,
  type UserLibraryDocument,
} from "#/lib/api";
import { formatBytes } from "#/lib/documents/format-bytes";

const PAGE_SIZE = 20;

export type DocumentLibraryModalProps = {
  open: boolean;
  onClose: () => void;
  /** Document ids already active in the current session. */
  activeDocumentIds?: ReadonlySet<string>;
  /**
   * When set, only list that project's corpus (attach isolation).
   * When null/omitted, list standalone docs only.
   */
  projectId?: string | null;
  onConfirm: (documents: UserLibraryDocument[]) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
};

export function DocumentLibraryModal({
  open,
  onClose,
  activeDocumentIds,
  projectId = null,
  onConfirm,
  busy = false,
  error = null,
}: DocumentLibraryModalProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [items, setItems] = useState<UserLibraryDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Only set when user explicitly clicks Preview — never auto-focus. */
  const [previewDoc, setPreviewDoc] = useState<UserLibraryDocument | null>(
    null,
  );
  const loadMoreLock = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  // Keep selected docs across search/pagination so confirm still has full objects.
  const selectedCacheRef = useRef<Map<string, UserLibraryDocument>>(new Map());
  const wasOpenRef = useRef(false);

  const resetListState = useCallback(() => {
    setItems([]);
    setNextCursor(null);
    setListError(null);
    setPreviewDoc(null);
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const page = await listUserDocuments({
        query: debouncedQuery,
        limit: PAGE_SIZE,
        scope: "attach",
        projectId,
      });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setPreviewDoc((current) => {
        if (!current) return null;
        // Keep preview if that doc is still in the result set; otherwise clear.
        return page.items.some((d) => d.id === current.id) ? current : null;
      });
    } catch {
      setListError("Could not load documents");
      resetListState();
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, projectId, resetListState]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadMoreLock.current || loadingMore || loading) return;
    loadMoreLock.current = true;
    setLoadingMore(true);
    try {
      const page = await listUserDocuments({
        query: debouncedQuery,
        cursor: nextCursor,
        limit: PAGE_SIZE,
        scope: "attach",
        projectId,
      });
      setItems((current) => {
        const seen = new Set(current.map((d) => d.id));
        const appended = page.items.filter((d) => !seen.has(d.id));
        return [...current, ...appended];
      });
      setNextCursor(page.nextCursor);
    } catch {
      // Keep existing list; user can scroll again.
    } finally {
      setLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [debouncedQuery, loading, loadingMore, nextCursor, projectId]);

  // Seed selection with docs already linked to this session when the modal opens.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setQuery("");
      setSelectedIds(new Set(activeDocumentIds ?? []));
      setPreviewDoc(null);
      selectedCacheRef.current = new Map();
    }
    wasOpenRef.current = open;
  }, [open, activeDocumentIds]);

  useEffect(() => {
    if (!open) return;
    void loadFirstPage();
  }, [open, loadFirstPage]);

  useInfiniteScrollSentinel({
    sentinelRef,
    hasMore: Boolean(nextCursor),
    loading,
    loadingMore,
    onLoadMore: () => {
      void loadMore();
    },
    itemCount: items.length,
    rootSelector: "[data-library-scroll]",
  });

  const toggleSelect = (doc: UserLibraryDocument) => {
    selectedCacheRef.current.set(doc.id, doc);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(doc.id)) next.delete(doc.id);
      else next.add(doc.id);
      return next;
    });
  };

  useEffect(() => {
    for (const item of items) {
      if (selectedIds.has(item.id)) {
        selectedCacheRef.current.set(item.id, item);
      }
    }
    for (const id of [...selectedCacheRef.current.keys()]) {
      if (!selectedIds.has(id)) selectedCacheRef.current.delete(id);
    }
  }, [items, selectedIds]);

  // Ensure already-active docs that appear in the list stay marked chosen.
  useEffect(() => {
    if (!open || !activeDocumentIds || activeDocumentIds.size === 0) return;
    setSelectedIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of activeDocumentIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [open, activeDocumentIds, items]);

  const handleConfirm = async () => {
    const docs = [...selectedIds]
      .map((id) => {
        const cached = selectedCacheRef.current.get(id);
        if (cached) return cached;
        // Stub for already-active ids not yet loaded in the list page.
        return {
          id,
          filename: "Document",
          firstPageSummary: "",
          sizeBytes: 0,
          mimeType: "application/octet-stream",
          pageCount: 0,
          createdAt: new Date().toISOString(),
          originSessionId: "",
        } satisfies UserLibraryDocument;
      });
    if (docs.length === 0) return;
    await onConfirm(docs);
  };

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Choose documents"
      description="Pick files you already uploaded to add to this chat"
      size="xl"
      dismissDisabled={busy}
      footer={
        <>
          <span className="mr-auto text-[11px] text-text-faint">
            {selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : "Select one or more files"}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={DIALOG_SECONDARY_BUTTON_CLASS}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={busy || selectedIds.size === 0}
            className={DIALOG_PRIMARY_BUTTON_CLASS}
          >
            {busy ? "Adding…" : "Add to chat"}
          </button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* List: full width until preview opens, then ~1/3 */}
        <div
          className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
            previewDoc
              ? "h-[38%] shrink-0 border-b border-white/[0.06] md:h-auto md:w-1/3 md:border-b-0 md:border-r"
              : "flex-1"
          }`}
        >
          <div className="shrink-0 px-3 py-2.5">
            <label className="relative block">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-text-faint"
                strokeWidth={1.75}
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by filename or summary…"
                className="w-full rounded-xl bg-white/[0.04] py-2 pl-9 pr-3 text-sm text-text outline-none ring-1 ring-white/[0.08] transition placeholder:text-text-faint focus:bg-white/[0.055] focus:ring-2 focus:ring-accent-ring"
                disabled={busy}
              />
            </label>
          </div>

          {(error || listError) && (
            <p className="px-3 pb-2 text-xs text-danger" role="alert">
              {error || listError}
            </p>
          )}

          <div
            ref={listScrollRef}
            data-library-scroll
            className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3"
          >
            {loading && items.length === 0 ? (
              <div className="flex flex-col gap-2 px-0.5 py-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="skeleton-shimmer h-16 rounded-xl"
                    style={{ opacity: 1 - i * 0.1 }}
                  />
                ))}
              </div>
            ) : null}

            {!loading && items.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-text-faint">
                {debouncedQuery
                  ? "No documents match your search"
                  : "No ready documents yet — upload one from the composer"}
              </p>
            ) : null}

            <ul className="flex list-none flex-col gap-1.5 p-0">
              {items.map((doc) => {
                const selected = selectedIds.has(doc.id);
                const alreadyActive = activeDocumentIds?.has(doc.id) ?? false;
                const previewing = previewDoc?.id === doc.id;
                return (
                  <li key={doc.id}>
                    <DocumentRow
                      filename={doc.filename}
                      summary={doc.firstPageSummary}
                      meta={[
                        alreadyActive ? "In this chat" : null,
                        doc.pageCount > 0 ? `${doc.pageCount}p` : null,
                        formatBytes(doc.sizeBytes),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      selected={selected}
                      focused={previewing}
                      data-document-id={doc.id}
                      onClick={() => toggleSelect(doc)}
                      trailing={
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label={`Preview ${doc.filename}`}
                            title="Preview"
                            aria-pressed={previewing}
                            onClick={(event) => {
                              event.stopPropagation();
                              setPreviewDoc((current) =>
                                current?.id === doc.id ? null : doc,
                              );
                            }}
                            className={`inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md transition ${
                              previewing
                                ? "bg-accent-soft text-accent ring-1 ring-accent-ring/40"
                                : "text-text-faint ring-1 ring-white/15 hover:bg-white/[0.06] hover:text-text"
                            }`}
                          >
                            <Eye className="size-3" strokeWidth={2} />
                          </button>
                          <span
                            className={`inline-flex size-5 items-center justify-center rounded-md border ${
                              selected
                                ? "border-accent bg-accent text-canvas"
                                : "border-white/15 text-transparent"
                            }`}
                            aria-hidden
                          >
                            <Check className="size-3" strokeWidth={2.5} />
                          </span>
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>

            <div ref={sentinelRef} className="h-4 w-full" aria-hidden />
            {loadingMore ? (
              <p className="py-2 text-center text-[11px] text-text-faint">
                Loading more…
              </p>
            ) : null}
          </div>
        </div>

        {/* Preview: only after user clicks Preview — ~2/3 width on desktop */}
        {previewDoc ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:w-2/3 md:flex-none animate-fade-in">
            <DocumentPreviewPane
              key={previewDoc.id}
              document={previewDoc}
              onClose={() => setPreviewDoc(null)}
            />
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}
