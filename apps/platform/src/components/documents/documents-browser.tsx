import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, Search } from "lucide-react";
import { DocumentPreviewModal } from "#/components/documents/document-preview-modal";
import { DocumentRow } from "#/components/documents/document-row";
import { WorkspaceMainPane } from "#/components/layout/workspace-main-pane";
import { useDebouncedValue } from "#/hooks/use-debounced-value";
import { useInfiniteScrollSentinel } from "#/hooks/use-infinite-scroll-sentinel";
import {
  listUserDocuments,
  type UserLibraryDocument,
} from "#/lib/api";
import { formatBytes } from "#/lib/documents/format-bytes";

const PAGE_SIZE = 30;

type Group = {
  key: string;
  label: string;
  items: UserLibraryDocument[];
};

export function DocumentsBrowser() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [items, setItems] = useState<UserLibraryDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<UserLibraryDocument | null>(
    null,
  );
  const loadMoreLock = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listUserDocuments({
        query: debouncedQuery,
        limit: PAGE_SIZE,
        scope: "browser",
      });
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch {
      setError("Could not load documents");
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loadMoreLock.current) return;
    loadMoreLock.current = true;
    setLoadingMore(true);
    try {
      const page = await listUserDocuments({
        query: debouncedQuery,
        cursor: nextCursor,
        limit: PAGE_SIZE,
        scope: "browser",
      });
      setItems((prev) => {
        const seen = new Set(prev.map((d) => d.id));
        const merged = [...prev];
        for (const item of page.items) {
          if (!seen.has(item.id)) merged.push(item);
        }
        return merged;
      });
      setNextCursor(page.nextCursor);
    } catch {
      // keep list; user can scroll again
    } finally {
      setLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [debouncedQuery, loadingMore, nextCursor]);

  useInfiniteScrollSentinel({
    sentinelRef,
    hasMore: Boolean(nextCursor),
    loading,
    loadingMore,
    onLoadMore: () => {
      void loadMore();
    },
    itemCount: items.length,
  });

  const groups = useMemo((): Group[] => {
    const map = new Map<string, Group>();
    for (const doc of items) {
      const key = doc.projectId ?? "__standalone__";
      const label = doc.projectName?.trim() || "Standalone";
      const group = map.get(key);
      if (group) {
        group.items.push(doc);
      } else {
        map.set(key, { key, label, items: [doc] });
      }
    }
    // Standalone last; projects alpha
    return [...map.values()].sort((a, b) => {
      if (a.key === "__standalone__") return 1;
      if (b.key === "__standalone__") return -1;
      return a.label.localeCompare(b.label);
    });
  }, [items]);

  return (
    <>
      <WorkspaceMainPane scroll={false}>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-text-faint">
          Library
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-text">
          Documents
        </h2>
        <p className="mt-1.5 text-sm text-text-muted">
          Browse uploads across projects. Preview only — add files from a chat.
        </p>

        <label className="relative mt-5 block shrink-0">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
            strokeWidth={1.75}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by filename…"
            className="w-full rounded-xl bg-white/[0.04] py-2.5 pl-10 pr-3 text-sm text-text outline-none ring-1 ring-white/[0.08] transition placeholder:text-text-faint focus:bg-white/[0.055] focus:ring-2 focus:ring-accent-ring"
          />
        </label>

        {error ? (
          <div className="mt-4 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {/*
          Bottom padding lives on the scroll content (not the clipped viewport)
          so the last row can scroll fully into view — clipToPadding=false style.
        */}
        <div
          ref={listScrollRef}
          className="chat-scroll mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {loading && items.length === 0 ? (
            <div className="space-y-2 pb-10">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-xl bg-white/[0.04]"
                />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl bg-white/[0.03] px-6 py-16 text-center ring-1 ring-white/[0.06]">
              <FileText
                className="mb-3 size-8 text-text-faint"
                strokeWidth={1.5}
              />
              <p className="text-sm font-medium text-text">No documents yet</p>
              <p className="mt-1 max-w-sm text-sm text-text-muted">
                Upload files from a chat composer. They will show up here,
                grouped by project when applicable.
              </p>
            </div>
          ) : (
            <div className="space-y-6 pb-10 md:pb-12">
              {groups.map((group) => (
                <section key={group.key}>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-faint">
                    {group.label}
                    <span className="ml-2 font-normal text-text-faint/80">
                      {group.items.length}
                    </span>
                  </h3>
                  <ul className="space-y-1">
                    {group.items.map((doc) => (
                      <li key={doc.id}>
                        <DocumentRow
                          filename={doc.filename}
                          summary={doc.firstPageSummary}
                          meta={`${formatBytes(doc.sizeBytes)}${
                            doc.pageCount
                              ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`
                              : ""
                          }`}
                          trailing={
                            <button
                              type="button"
                              onClick={() => setPreviewDoc(doc)}
                              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-text-muted transition hover:bg-white/[0.06] hover:text-text"
                            >
                              <Eye className="size-3.5" strokeWidth={1.75} />
                              Preview
                            </button>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <div ref={sentinelRef} className="h-4 shrink-0" aria-hidden />
              {loadingMore ? (
                <p className="py-2 text-center text-xs text-text-faint">
                  Loading more…
                </p>
              ) : null}
            </div>
          )}
        </div>
      </WorkspaceMainPane>

      <DocumentPreviewModal
        open={Boolean(previewDoc)}
        document={
          previewDoc
            ? {
                id: previewDoc.id,
                filename: previewDoc.filename,
                pageCount: previewDoc.pageCount,
              }
            : null
        }
        onClose={() => setPreviewDoc(null)}
      />
    </>
  );
}
