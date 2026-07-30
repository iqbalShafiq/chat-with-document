import { DocChatMark } from "#/components/layout/doc-chat-mark";
import { SessionHistoryList } from "#/components/sidebar/session-history-list";
import { AccountMenu } from "#/components/sidebar/account-menu";
import type { SessionSummary } from "#/lib/session-history";
import { PanelLeftClose, SquarePen, X } from "lucide-react";

export function ChatSidebar({
  sessions,
  activeSessionId,
  loading,
  loadingMore,
  error,
  hasMore,
  onSelect,
  onNewChat,
  onLoadMore,
  onRetry,
  onCollapse,
  onCloseMobile,
  showClose,
}: {
  sessions: SessionSummary[];
  activeSessionId: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  /** Desktop: collapse sidebar. Hidden on mobile drawer. */
  onCollapse?: () => void;
  onCloseMobile?: () => void;
  showClose?: boolean;
}) {
  return (
    <aside className="glass-sidebar flex h-full w-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1.5 px-2.5">
        {/* Brand + collapse switcher (revealed on hover / focus-within) */}
        <div className="group/brand relative flex min-w-0 flex-1 items-center gap-2">
          <div className="relative size-8 shrink-0">
            {/* Default logo */}
            <span
              className="absolute inset-0 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/brand:scale-95 group-hover/brand:opacity-0 group-focus-within/brand:scale-95 group-focus-within/brand:opacity-0"
              aria-hidden={Boolean(onCollapse)}
            >
              <DocChatMark />
            </span>

            {/* Collapse switcher — only when desktop collapse is available */}
            {onCollapse ? (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-xl border border-hairline bg-surface text-text-muted opacity-0 scale-95 pointer-events-none transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/brand:pointer-events-auto group-hover/brand:scale-100 group-hover/brand:opacity-100 group-focus-within/brand:pointer-events-auto group-focus-within/brand:scale-100 group-focus-within/brand:opacity-100 hover:bg-surface-elevated hover:text-text focus-visible:pointer-events-auto focus-visible:scale-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-[0.96]"
              >
                <PanelLeftClose className="size-4" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>

          <span className="truncate text-sm font-semibold tracking-tight text-text transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]">
            DocChat
          </span>
        </div>

        {/* New chat — pencil icon */}
        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile?.();
          }}
          aria-label="New chat"
          title="New chat"
          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <SquarePen className="size-4" strokeWidth={1.75} />
        </button>

        {showClose ? (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close sidebar"
            className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface hover:text-text active:scale-[0.96] md:hidden"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <SessionHistoryList
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          onSelect={(id) => {
            onSelect(id);
            onCloseMobile?.();
          }}
          onLoadMore={onLoadMore}
          onRetry={onRetry}
        />
      </div>

      <div className="shrink-0 border-t border-white/[0.08]">
        <AccountMenu />
      </div>
    </aside>
  );
}
