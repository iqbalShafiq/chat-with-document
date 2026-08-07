import { AuroraBackground } from "#/components/layout/aurora-background";
import { ChatTopBar } from "#/components/layout/chat-top-bar";
import {
  ChatSidebar,
  type WorkspaceViewMode,
} from "#/components/sidebar/chat-sidebar";
import type { SessionUser } from "#/lib/auth-client";
import type { SessionSummary } from "#/lib/session-history";
import type { ProjectListItem } from "#/lib/api";
import { useEffect, useState, type ReactNode } from "react";

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [breakpoint]);

  return mobile;
}

export function AppShell({
  user,
  sessions,
  activeSessionId,
  activeRuns = new Set(),
  activeTitle,
  sessionsLoading,
  sessionsLoadingMore,
  sessionsError,
  hasMoreSessions,
  onSelectSession,
  onNewChat,
  newChatDisabled = false,
  onLoadMoreSessions,
  onRetrySessions,
  viewMode,
  recentProjects,
  activeProjectId,
  onOpenAllChats,
  onOpenProjects,
  onOpenDocuments,
  onOpenRecentProject,
  children,
}: {
  user: SessionUser;
  sessions: SessionSummary[];
  activeSessionId: string;
  /** Task 5 wires this from Home; defaults to empty so the sidebar renders without it. */
  activeRuns?: ReadonlySet<string>;
  activeTitle: string;
  sessionsLoading: boolean;
  sessionsLoadingMore: boolean;
  sessionsError: string | null;
  hasMoreSessions: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  newChatDisabled?: boolean;
  onLoadMoreSessions: () => void;
  onRetrySessions: () => void;
  viewMode: WorkspaceViewMode;
  recentProjects: ProjectListItem[];
  activeProjectId: string | null;
  onOpenAllChats: () => void;
  onOpenProjects: () => void;
  onOpenDocuments: () => void;
  onOpenRecentProject: (project: ProjectListItem) => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const toggleSidebar = () => {
    if (isMobile) {
      setMobileOpen((v) => !v);
    } else {
      setSidebarOpen((v) => !v);
    }
  };

  const sidebarProps = {
    user,
    sessions,
    activeSessionId,
    activeRuns,
    loading: sessionsLoading,
    loadingMore: sessionsLoadingMore,
    error: sessionsError,
    hasMore: hasMoreSessions,
    onSelect: onSelectSession,
    onNewChat,
    newChatDisabled,
    onLoadMore: onLoadMoreSessions,
    onRetry: onRetrySessions,
    viewMode,
    recentProjects,
    activeProjectId,
    onOpenAllChats,
    onOpenProjects,
    onOpenDocuments,
    onOpenRecentProject,
  };

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] overflow-hidden text-text">
      <AuroraBackground />

      <div className="relative z-[1] flex min-h-0 min-w-0 flex-1">
        {/* Desktop sidebar — full-bleed */}
        <div
          className={`hidden shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:block ${
            sidebarOpen
              ? "w-[272px] translate-x-0 opacity-100"
              : "w-0 -translate-x-1 opacity-0 pointer-events-none"
          }`}
        >
          <div className="h-full w-[272px]">
            <ChatSidebar
              {...sidebarProps}
              onCollapse={() => setSidebarOpen(false)}
            />
          </div>
        </div>

        {/* Mobile drawer */}
        {isMobile && mobileOpen ? (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              aria-label="Close menu"
              className="absolute inset-0 bg-canvas/60 animate-fade-in"
              onClick={() => setMobileOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-[min(288px,88vw)] animate-fade-up shadow-2xl">
              <ChatSidebar
                {...sidebarProps}
                onCloseMobile={() => setMobileOpen(false)}
                showClose
              />
            </div>
          </div>
        ) : null}

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatTopBar
            title={activeTitle}
            sidebarOpen={isMobile ? mobileOpen : sidebarOpen}
            isMobile={isMobile}
            onToggleSidebar={toggleSidebar}
            onNewChat={onNewChat}
            newChatDisabled={newChatDisabled}
          />
          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {/*
              Curved L-separator — only while desktop sidebar is open;
              opacity/border animate out when collapsed.
            */}
            <div
              aria-hidden
              className={`content-frame ${
                !isMobile && sidebarOpen ? "content-frame--with-sidebar" : ""
              }`}
            />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
