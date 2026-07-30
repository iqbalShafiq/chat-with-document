import {
  groupSessionsByDate,
  type SessionSummary,
} from "#/lib/session-history";
import { useEffect, useMemo, useRef } from "react";

export function SessionHistoryList({
  sessions,
  activeSessionId,
  loading,
  loadingMore,
  error,
  hasMore,
  onSelect,
  onLoadMore,
  onRetry,
}: {
  sessions: SessionSummary[];
  activeSessionId: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onSelect: (sessionId: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupSessionsByDate(sessions), [sessions]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onLoadMore();
        }
      },
      { root: node.closest(".chat-scroll"), rootMargin: "80px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, onLoadMore, sessions.length]);

  if (loading && sessions.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer h-9 rounded-xl"
            style={{ opacity: 1 - i * 0.08 }}
          />
        ))}
      </div>
    );
  }

  // Show error even when a local draft exists — otherwise a failed fetch
  // looks like "only New chat" with no way to recover.
  const errorBanner =
    error && !loading ? (
      <div className="mb-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2">
        <p className="text-xs text-danger">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex min-h-8 cursor-pointer items-center rounded-lg border border-hairline bg-surface px-2.5 text-[11px] font-medium text-text transition hover:bg-surface-elevated active:scale-[0.98]"
        >
          Retry
        </button>
      </div>
    ) : null;

  if (sessions.length === 0) {
    return (
      <div>
        {errorBanner}
        <p className="px-3 py-8 text-center text-sm text-text-faint">
          No conversations yet
        </p>
      </div>
    );
  }

  let itemIndex = 0;

  return (
    <div className="flex flex-col gap-4 px-2.5 pb-2.5">
      {errorBanner}
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-0.5">
          <h3 className="sticky top-0 z-10 bg-transparent px-2.5 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-faint">
            {group.label}
          </h3>
          <ul className="flex list-none flex-col gap-0.5 p-0">
            {group.items.map((session) => {
              const selected = session.sessionId === activeSessionId;
              const i = itemIndex++;
              return (
                <li
                  key={session.sessionId}
                  className="stagger-item"
                  style={{ ["--i" as string]: Math.min(i, 12) }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(session.sessionId)}
                    title={session.title}
                    aria-current={selected ? "page" : undefined}
                    className={`flex w-full min-h-9 cursor-pointer items-center rounded-xl px-3.5 py-2.5 text-left text-[13px] leading-snug transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.99] ${
                      selected
                        ? "glass-pane font-medium text-text"
                        : "text-text-muted hover:bg-white/[0.035] hover:text-text"
                    }`}
                  >
                    <span className="truncate">{session.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <div ref={sentinelRef} className="h-4 w-full shrink-0" aria-hidden />

      {loadingMore ? (
        <div className="flex flex-col gap-2 px-1 pb-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton-shimmer h-8 rounded-xl" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
