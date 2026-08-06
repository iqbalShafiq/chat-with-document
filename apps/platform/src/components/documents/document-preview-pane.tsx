import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  buildDocumentImageUrl,
  getDocumentPreview,
  type DocumentPageImageInfo,
  type DocumentPreviewPage,
} from "#/lib/api";
import { DocumentImage } from "#/components/images/document-image";
import { DocumentMarkdown } from "#/components/documents/document-markdown";
import { formatBytes } from "#/lib/documents/format-bytes";
import type { PreviewableDocument } from "#/lib/documents/previewable-document";

type LoadedMeta = {
  filename: string;
  mimeType: string;
  pageCount: number;
  sizeBytes: number;
  firstPageSummary: string;
};

/** How many pages to preload before/after the opening page. */
const PRELOAD_RADIUS = 2;

/**
 * Lazy document preview with infinite scroll pagination.
 * Opens around `initialPageIndex` (preloads ±2 pages), then loads more
 * pages when scrolling down (next) or up (previous).
 */
export function DocumentPreviewPane({
  document,
  initialPageIndex = 0,
  showHeader = true,
  onClose,
  onMetaChange,
}: {
  document: PreviewableDocument;
  /** 0-based page index to open first (e.g. from a citation). */
  initialPageIndex?: number;
  /** When false, parent owns the chrome (e.g. DialogShell header). */
  showHeader?: boolean;
  onClose?: () => void;
  onMetaChange?: (meta: LoadedMeta) => void;
}) {
  const startPage = Math.max(0, initialPageIndex);
  const [meta, setMeta] = useState<LoadedMeta | null>(null);
  const [pageCache, setPageCache] = useState<
    Map<number, DocumentPreviewPage>
  >(() => new Map());
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDirection, setLoadingDirection] = useState<
    "next" | "prev" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const pageCacheRef = useRef(pageCache);
  pageCacheRef.current = pageCache;
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const loadingMoreRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const needsScrollToStartRef = useRef(false);

  const applyMeta = useCallback(
    (next: LoadedMeta) => {
      setMeta(next);
      metaRef.current = next;
      onMetaChange?.(next);
    },
    [onMetaChange],
  );

  const fetchPage = useCallback(
    async (index: number): Promise<DocumentPreviewPage | null> => {
      const data = await getDocumentPreview({
        documentId: document.id,
        pageIndex: index,
        pageLimit: 1,
      });

      applyMeta({
        filename: data.filename,
        mimeType: data.mimeType,
        pageCount: data.pageCount,
        sizeBytes: data.sizeBytes,
        firstPageSummary: data.firstPageSummary,
      });

      return (
        data.pages[0] ?? {
          pageIndex: index,
          summary: "",
          rawMarkdown: "",
        }
      );
    },
    [applyMeta, document.id],
  );

  const mergePages = useCallback((pages: DocumentPreviewPage[]) => {
    if (pages.length === 0) return;
    setPageCache((current) => {
      const next = new Map(current);
      for (const page of pages) {
        next.set(page.pageIndex, page);
      }
      pageCacheRef.current = next;
      return next;
    });
  }, []);

  const loadPageIfMissing = useCallback(
    async (index: number) => {
      if (index < 0) return false;
      const pageCount = metaRef.current?.pageCount;
      if (typeof pageCount === "number" && index >= pageCount) return false;
      if (pageCacheRef.current.has(index)) return true;

      const page = await fetchPage(index);
      if (!page) return false;
      mergePages([page]);
      return true;
    },
    [fetchPage, mergePages],
  );

  // Reset + load start page ± PRELOAD_RADIUS when document / jump target changes.
  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    const empty = new Map<number, DocumentPreviewPage>();
    setPageCache(empty);
    pageCacheRef.current = empty;
    setMeta(null);
    metaRef.current = null;
    setError(null);
    setLoadingInitial(true);
    setLoadingMore(false);
    setLoadingDirection(null);
    loadingMoreRef.current = false;
    needsScrollToStartRef.current = true;

    void (async () => {
      try {
        // 1) Load the target page first (also yields pageCount).
        const center = await fetchPage(startPage);
        if (generation !== loadGenerationRef.current) return;
        if (!center) throw new Error("Empty page");

        const pageCount = metaRef.current?.pageCount ?? 0;
        const lastIndex =
          pageCount > 0 ? pageCount - 1 : Number.POSITIVE_INFINITY;
        const from = Math.max(0, startPage - PRELOAD_RADIUS);
        const to = Math.min(lastIndex, startPage + PRELOAD_RADIUS);

        const neighborIndexes: number[] = [];
        for (let i = from; i <= to; i += 1) {
          if (i !== startPage && Number.isFinite(i)) neighborIndexes.push(i);
        }

        // 2) Preload up to 2 pages before + 2 after (parallel).
        const neighbors = await Promise.all(
          neighborIndexes.map(async (index) => {
            try {
              return await fetchPage(index);
            } catch {
              return null;
            }
          }),
        );
        if (generation !== loadGenerationRef.current) return;

        const next = new Map<number, DocumentPreviewPage>();
        next.set(startPage, center);
        for (const page of neighbors) {
          if (page) next.set(page.pageIndex, page);
        }
        setPageCache(next);
        pageCacheRef.current = next;
      } catch {
        if (generation !== loadGenerationRef.current) return;
        setError("Could not load preview");
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoadingInitial(false);
        }
      }
    })();
  }, [document.id, startPage, fetchPage]);

  // After initial window is ready, scroll the opening page into view
  // (needed when pages before startPage were preloaded).
  useEffect(() => {
    if (loadingInitial || !needsScrollToStartRef.current) return;
    if (!pageCache.has(startPage)) return;

    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(
      `[data-preview-page="${startPage}"]`,
    );
    if (target) {
      // Instant jump so the cited page is visible, not the preloaded pages above.
      target.scrollIntoView({ block: "start", behavior: "auto" });
    }
    needsScrollToStartRef.current = false;
  }, [loadingInitial, pageCache, startPage]);

  const loadAdjacent = useCallback(
    async (direction: "next" | "prev") => {
      if (loadingMoreRef.current) return;
      const cache = pageCacheRef.current;
      if (cache.size === 0) return;

      const indices = [...cache.keys()].sort((a, b) => a - b);
      const min = indices[0]!;
      const max = indices[indices.length - 1]!;
      const pageCount = metaRef.current?.pageCount ?? document.pageCount ?? 0;
      const target = direction === "next" ? max + 1 : min - 1;

      if (target < 0) return;
      if (pageCount > 0 && target >= pageCount) return;
      if (cache.has(target)) return;

      loadingMoreRef.current = true;
      setLoadingMore(true);
      setLoadingDirection(direction);
      const generation = loadGenerationRef.current;
      const scrollEl = scrollRef.current;
      const prevHeight = scrollEl?.scrollHeight ?? 0;
      const prevTop = scrollEl?.scrollTop ?? 0;

      try {
        await loadPageIfMissing(target);
        if (generation !== loadGenerationRef.current) return;

        // Preserve viewport when prepending earlier pages.
        if (direction === "prev" && scrollEl) {
          requestAnimationFrame(() => {
            const delta = scrollEl.scrollHeight - prevHeight;
            scrollEl.scrollTop = prevTop + delta;
          });
        }
      } catch {
        if (generation !== loadGenerationRef.current) return;
        setError("Could not load more pages");
      } finally {
        if (generation === loadGenerationRef.current) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
          setLoadingDirection(null);
        }
      }
    },
    [document.pageCount, loadPageIfMissing],
  );

  // Infinite scroll: bottom → next, top → previous.
  useEffect(() => {
    const root = scrollRef.current;
    const bottom = bottomSentinelRef.current;
    const top = topSentinelRef.current;
    if (!root || loadingInitial) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === bottom) {
            void loadAdjacent("next");
          } else if (entry.target === top) {
            void loadAdjacent("prev");
          }
        }
      },
      { root, rootMargin: "120px", threshold: 0 },
    );

    if (bottom) observer.observe(bottom);
    if (top) observer.observe(top);
    return () => observer.disconnect();
  }, [loadAdjacent, loadingInitial, pageCache.size, meta?.pageCount]);

  const pageCount = meta?.pageCount ?? document.pageCount ?? 0;
  const isImage = (meta?.mimeType ?? document.mimeType ?? "").startsWith(
    "image/",
  );
  const orderedPages = [...pageCache.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, page]) => page);

  const minLoaded =
    orderedPages.length > 0 ? orderedPages[0]!.pageIndex : startPage;
  const maxLoaded =
    orderedPages.length > 0
      ? orderedPages[orderedPages.length - 1]!.pageIndex
      : startPage;
  const hasPrev = minLoaded > 0;
  const hasNext = pageCount > 0 ? maxLoaded + 1 < pageCount : false;

  const headerMeta = [
    pageCount > 0 ? `${pageCount} pages` : null,
    formatBytes(meta?.sizeBytes ?? document.sizeBytes ?? 0),
    meta?.mimeType ?? document.mimeType,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {showHeader ? (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-text">
              {meta?.filename ?? document.filename}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-text-faint">
              {headerMeta || "Loading…"}
            </p>
          </div>
          {onClose ? (
            <button
              type="button"
              aria-label="Close preview"
              onClick={onClose}
              className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96]"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {loadingInitial && orderedPages.length === 0 ? (
          <div className="space-y-2">
            <div className="skeleton-shimmer h-3 w-3/4 rounded" />
            <div className="skeleton-shimmer h-3 w-full rounded" />
            <div className="skeleton-shimmer h-3 w-5/6 rounded" />
            <div className="skeleton-shimmer h-24 w-full rounded-lg" />
          </div>
        ) : null}

        {error && orderedPages.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
            <button
              type="button"
              onClick={() => {
                setError(null);
                // Re-trigger the main load effect by bumping generation via state reset
                // — simplest path: reload the window once more inline.
                setLoadingInitial(true);
                needsScrollToStartRef.current = true;
                void (async () => {
                  try {
                    const center = await fetchPage(startPage);
                    const count = metaRef.current?.pageCount ?? 0;
                    const last = count > 0 ? count - 1 : startPage;
                    const from = Math.max(0, startPage - PRELOAD_RADIUS);
                    const to = Math.min(last, startPage + PRELOAD_RADIUS);
                    const neighborIndexes: number[] = [];
                    for (let i = from; i <= to; i += 1) {
                      if (i !== startPage) neighborIndexes.push(i);
                    }
                    const neighbors = await Promise.all(
                      neighborIndexes.map(async (index) => {
                        try {
                          return await fetchPage(index);
                        } catch {
                          return null;
                        }
                      }),
                    );
                    const next = new Map<number, DocumentPreviewPage>();
                    if (center) next.set(startPage, center);
                    for (const page of neighbors) {
                      if (page) next.set(page.pageIndex, page);
                    }
                    setPageCache(next);
                    pageCacheRef.current = next;
                  } catch {
                    setError("Could not load preview");
                  } finally {
                    setLoadingInitial(false);
                  }
                })();
              }}
              className="inline-flex w-fit cursor-pointer items-center rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-[11px] font-medium text-text transition hover:bg-surface-elevated"
            >
              Retry
            </button>
          </div>
        ) : null}

        {orderedPages.length > 0 ? (
          <div className="flex flex-col gap-6">
            <div
              ref={topSentinelRef}
              className="h-px w-full shrink-0"
              aria-hidden
            />
            {hasPrev && loadingMore && loadingDirection === "prev" ? (
              <p className="text-center text-[11px] text-text-faint">
                Loading previous page…
              </p>
            ) : null}

            {orderedPages.map((page) => (
              <section
                key={page.pageIndex}
                data-preview-page={page.pageIndex}
                className="flex flex-col gap-2 border-b border-white/[0.05] pb-6 last:border-b-0 last:pb-0"
              >
                <p className="text-[10px] font-medium uppercase tracking-wide text-text-faint">
                  Page {page.pageIndex + 1}
                  {pageCount > 0 ? ` of ${pageCount}` : ""}
                </p>

                {page.summary ? (
                  <p className="rounded-lg bg-white/[0.03] px-2.5 py-2 text-[11px] leading-relaxed text-text-muted ring-1 ring-white/[0.04]">
                    {page.summary}
                  </p>
                ) : null}

                {isImage && !page.rawMarkdown ? (
                  <p className="text-[11px] text-text-faint">
                    Image document — text extraction appears after OCR when
                    available.
                  </p>
                ) : null}

                {page.rawMarkdown ? (
                  <DocumentMarkdown content={page.rawMarkdown} />
                ) : !isImage ? (
                  <p className="text-[11px] text-text-faint">
                    No content on this page.
                  </p>
                ) : null}

                {page.images && page.images.length > 0 ? (
                  <div
                    className="grid grid-cols-2 gap-2"
                    aria-label={`Images on page ${page.pageIndex + 1}`}
                  >
                    {page.images.map((image: DocumentPageImageInfo) => (
                      <DocumentImage
                        key={image.id}
                        src={buildDocumentImageUrl(
                          document.id,
                          page.pageIndex,
                          image.id,
                        )}
                        alt={`Image ${image.id} — page ${page.pageIndex + 1}`}
                        className="aspect-video w-full object-cover"
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ))}

            {hasNext && loadingMore && loadingDirection === "next" ? (
              <p className="text-center text-[11px] text-text-faint">
                Loading next page…
              </p>
            ) : null}
            <div
              ref={bottomSentinelRef}
              className="h-px w-full shrink-0"
              aria-hidden
            />
          </div>
        ) : null}

        {!loadingInitial &&
        !error &&
        orderedPages.length === 0 &&
        pageCount === 0 ? (
          <p className="text-[11px] text-text-faint">
            No page preview available.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export type { LoadedMeta as DocumentPreviewMeta };
