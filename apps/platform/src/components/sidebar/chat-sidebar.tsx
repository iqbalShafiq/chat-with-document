import { DocChatMark } from "#/components/layout/doc-chat-mark";
import { SessionHistoryList } from "#/components/sidebar/session-history-list";
import { AccountMenu } from "#/components/sidebar/account-menu";
import type { SessionUser } from "#/lib/auth-client";
import type { SessionSummary } from "#/lib/session-history";
import type { ProjectListItem } from "#/lib/api";
import {
  FileText,
  FolderKanban,
  PanelLeftClose,
  SquarePen,
  X,
} from "lucide-react";

export type WorkspaceViewMode =
  | "standalone"
  | "projects-index"
  | "project-workspace"
  | "documents-index";

export function ChatSidebar({
  user,
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
  viewMode,
  recentProjects,
  activeProjectId,
  onOpenProjects,
  onOpenDocuments,
  onOpenRecentProject,
}: {
  user: SessionUser;
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
  viewMode: WorkspaceViewMode;
  recentProjects: ProjectListItem[];
  activeProjectId: string | null;
  onOpenProjects: () => void;
  onOpenDocuments: () => void;
  onOpenRecentProject: (project: ProjectListItem) => void;
}) {
  return (
    <aside className="glass-sidebar flex h-full w-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1.5 px-2.5">
        {/* Brand + collapse switcher (revealed on hover / focus-within) */}
        <div className="group/brand relative flex min-w-0 flex-1 items-center gap-2">
          <div className="relative size-8 shrink-0">
            <span
              className="absolute inset-0 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/brand:scale-95 group-hover/brand:opacity-0 group-focus-within/brand:scale-95 group-focus-within/brand:opacity-0"
              aria-hidden={Boolean(onCollapse)}
            >
              <DocChatMark />
            </span>

            {onCollapse ? (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-xl bg-white/[0.06] text-text-muted opacity-0 scale-95 pointer-events-none transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/brand:pointer-events-auto group-hover/brand:scale-100 group-hover/brand:opacity-100 group-focus-within/brand:pointer-events-auto group-focus-within/brand:scale-100 group-focus-within/brand:opacity-100 hover:bg-white/[0.1] hover:text-text focus-visible:pointer-events-auto focus-visible:scale-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-[0.96]"
              >
                <PanelLeftClose className="size-4" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>

          <span className="truncate text-sm font-semibold tracking-tight text-text transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]">
            DocChat
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile?.();
          }}
          aria-label="New chat"
          title="New chat"
          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <SquarePen className="size-4" strokeWidth={1.75} />
        </button>

        {showClose ? (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close sidebar"
            className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.96] md:hidden"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-2 pb-2">
          <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-faint">
            Workspace
          </p>

          <button
            type="button"
            onClick={() => {
              onOpenProjects();
              onCloseMobile?.();
            }}
            className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              viewMode === "projects-index"
                ? "bg-white/[0.08] text-text"
                : "text-text-muted hover:bg-white/[0.05] hover:text-text"
            }`}
          >
            <FolderKanban className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate font-medium">Projects</span>
          </button>

          {recentProjects.length > 0 ? (
            <ul className="mt-0.5 space-y-0.5 border-l border-white/[0.06] ml-4 pl-2">
              {recentProjects.map((project) => {
                const active =
                  viewMode === "project-workspace" &&
                  activeProjectId === project.id;
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenRecentProject(project);
                        onCloseMobile?.();
                      }}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                        active
                          ? "bg-accent-soft/40 text-accent"
                          : "text-text-muted hover:bg-white/[0.05] hover:text-text"
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          active ? "bg-accent" : "bg-white/20"
                        }`}
                      />
                      <span className="truncate">{project.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <button
            type="button"
            onClick={() => {
              onOpenDocuments();
              onCloseMobile?.();
            }}
            className={`mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              viewMode === "documents-index"
                ? "bg-white/[0.08] text-text"
                : "text-text-muted hover:bg-white/[0.05] hover:text-text"
            }`}
          >
            <FileText className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate font-medium">
              Documents
            </span>
          </button>
        </div>

        <SessionHistoryList
          sessions={sessions}
          activeSessionId={
            viewMode === "standalone" || viewMode === "project-workspace"
              ? activeSessionId
              : ""
          }
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

      <div className="shrink-0">
        <AccountMenu user={user} />
      </div>
    </aside>
  );
}
