import { SessionActionsMenu } from "#/components/sidebar/session-actions";
import {
  groupSessionsByDate,
  type SessionSummary,
} from "#/lib/session-history";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function SessionHistoryList({
  sessions,
  activeSessionId,
  activeRuns,
  loading,
  loadingMore,
  error,
  hasMore,
  onSelect,
  onLoadMore,
  onRetry,
  onRenameSession,
  onDeleteSession,
  onRemoveSession,
  /** Top padding for the first date label (e.g. when Recent projects is above). */
  firstGroupTopPad = "pt-1",
}: {
  sessions: SessionSummary[];
  activeSessionId: string;
  activeRuns: ReadonlySet<string>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onSelect: (sessionId: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRemoveSession: (sessionId: string) => void;
  firstGroupTopPad?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupSessionsByDate(sessions), [sessions]);

  // Stable ref objects per row, used as the floating menu anchor so the
  // popover aligns with the history item (not the vertically-centered "⋯"
  // button inside it).
  const rowAnchorRefs = useRef(
    new Map<string, { current: HTMLLIElement | null }>(),
  );
  const rowAnchorRef = (sessionId: string) => {
    let ref = rowAnchorRefs.current.get(sessionId);
    if (!ref) {
      ref = { current: null };
      rowAnchorRefs.current.set(sessionId, ref);
    }
    return ref;
  };

  // Rows pending removal play a fade-out before the parent drops them.
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(new Set());
  const exitTimerRef = useRef<number | null>(null);

  const handleRemoved = useCallback(
    (sessionId: string) => {
      setExitingIds((current) => {
        const next = new Set(current);
        next.add(sessionId);
        return next;
      });
      exitTimerRef.current = window.setTimeout(() => {
        setExitingIds((current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
        onRemoveSession(sessionId);
      }, 220);
    },
    [onRemoveSession],
  );

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    };
  }, []);

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
    <div className="flex flex-col px-2.5 pb-2.5">
      {errorBanner}
      {groups.map((group, groupIndex) => (
        <section key={group.label} className="flex flex-col gap-0.5">
          {/*
            No inter-section gap: label top padding alone separates periods so
            spacing matches label→first-item (symmetric, no extra margin).
          */}
          <h3
            className={`sticky top-0 z-10 bg-transparent px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-faint ${
              groupIndex === 0 ? firstGroupTopPad : "pt-2"
            }`}
          >
            {group.label}
          </h3>
          <ul className="flex list-none flex-col gap-0.5 p-0">
            {group.items.map((session) => {
              const selected = session.sessionId === activeSessionId;
              const running = activeRuns.has(session.sessionId);
              const unread = session.unread && !selected;
              const exiting = exitingIds.has(session.sessionId);
              const i = itemIndex++;
              return (
                <li
                  key={session.sessionId}
                  ref={rowAnchorRef(session.sessionId)}
                  className={`group/row stagger-item relative ${
                    exiting ? "animate-fade-out" : ""
                  }`}
                  style={{ ["--i" as string]: Math.min(i, 12) }}
                >
                  <div
                    className={`relative flex w-full min-h-9 items-center rounded-xl py-1 pl-3.5 pr-1.5 text-left text-[13px] leading-snug transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                      selected ? "glass-pane" : "group-hover/row:bg-white/[0.035]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(session.sessionId)}
                      title={session.title}
                      aria-current={selected ? "page" : undefined}
                      aria-busy={running || undefined}
                      className={`flex min-w-0 flex-1 cursor-pointer items-center py-1 text-left transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.99] group-hover/row:pr-9 ${
                        selected
                          ? "pr-9 font-medium text-text"
                          : "text-text-muted group-hover/row:text-text"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {session.title}
                      </span>
                      {unread ? (
                        <span
                          className="ml-2 size-1.5 shrink-0 rounded-full bg-accent opacity-100 transition-opacity duration-150 group-hover/row:opacity-0"
                          aria-label="Unread messages"
                          title="Unread"
                        />
                      ) : null}
                      {running ? (
                        <span
                          className="ml-2 size-4 shrink-0 text-accent"
                          aria-label="Running"
                          title="Running"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            className="size-full animate-spin"
                            aria-hidden
                          >
                            <circle
                              cx="8"
                              cy="8"
                              r="6.5"
                              stroke="currentColor"
                              strokeOpacity="0.15"
                              strokeWidth="2"
                            />
                            <circle
                              cx="8"
                              cy="8"
                              r="6.5"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeWidth="2"
                              strokeDasharray="12 29"
                            />
                          </svg>
                        </span>
                      ) : null}
                    </button>
                    <SessionActionsMenu
                      session={session}
                      running={running}
                      alwaysVisible={selected}
                      anchorRef={rowAnchorRef(session.sessionId)}
                      onRename={onRenameSession}
                      onDelete={onDeleteSession}
                      onRemoved={handleRemoved}
                    />
                  </div>
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
