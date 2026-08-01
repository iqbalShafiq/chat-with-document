import { useEffect, type RefObject } from "react";

/**
 * Observes a sentinel element and calls `onLoadMore` when it intersects.
 * Mirrors the pattern used by the session history list.
 */
export function useInfiniteScrollSentinel(input: {
  sentinelRef: RefObject<Element | null>;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Dependency that changes when the list grows (e.g. items.length). */
  itemCount: number;
  rootMargin?: string;
  /** Optional scroll root selector/class; falls back to nearest `.chat-scroll`. */
  rootSelector?: string;
}) {
  const {
    sentinelRef,
    hasMore,
    loading,
    loadingMore,
    onLoadMore,
    itemCount,
    rootMargin = "80px",
    rootSelector = ".chat-scroll",
  } = input;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading || loadingMore) return;

    const root =
      (node.closest(rootSelector) as Element | null) ??
      (node.parentElement as Element | null);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onLoadMore();
        }
      },
      { root, rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [
    sentinelRef,
    hasMore,
    loading,
    loadingMore,
    onLoadMore,
    itemCount,
    rootMargin,
    rootSelector,
  ]);
}
