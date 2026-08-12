import { DocChatMark } from "#/components/layout/doc-chat-mark";
import { ImageGalleryModal } from "#/components/images/image-gallery-modal";
import { SessionHistoryList } from "#/components/sidebar/session-history-list";
import { AccountMenu } from "#/components/sidebar/account-menu";
import type { SessionUser } from "#/lib/auth-client";
import type { SessionSummary } from "#/lib/session-history";
import { fetchProjectImages, fetchUserImages, type ProjectListItem } from "#/lib/api";
import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  FolderKanban,
  Images,
  MessagesSquare,
  PanelLeftClose,
  SquarePen,
  X,
} from "lucide-react";

export type WorkspaceViewMode =
  | "standalone"
  | "projects-index"
  | "project-workspace"
  | "documents-index";

const RECENT_PROJECTS_MAX = 5;

export function ChatSidebar({
  user,
  sessions,
  activeSessionId,
  activeRuns,
  loading,
  loadingMore,
  error,
  hasMore,
  onSelect,
  onNewChat,
  newChatDisabled = false,
  onLoadMore,
  onRetry,
  onRenameSession,
  onDeleteSession,
  onRemoveSession,
  onCollapse,
  onCloseMobile,
  showClose,
  viewMode,
  recentProjects,
  activeProjectId,
  onOpenAllChats,
  onOpenProjects,
  onOpenDocuments,
  onOpenRecentProject,
}: {
  user: SessionUser;
  sessions: SessionSummary[];
  activeSessionId: string;
  activeRuns: ReadonlySet<string>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  /** True when the active chat is still an empty "New chat" draft. */
  newChatDisabled?: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRemoveSession: (sessionId: string) => void;
  /** Desktop: collapse sidebar. Hidden on mobile drawer. */
  onCollapse?: () => void;
  onCloseMobile?: () => void;
  showClose?: boolean;
  viewMode: WorkspaceViewMode;
  recentProjects: ProjectListItem[];
  activeProjectId: string | null;
  /** Leave project / browser views and return to standalone chat history. */
  onOpenAllChats: () => void;
  onOpenProjects: () => void;
  onOpenDocuments: () => void;
  onOpenRecentProject: (project: ProjectListItem) => void;
}) {
  const visibleProjects = recentProjects.slice(0, RECENT_PROJECTS_MAX);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [imageCount, setImageCount] = useState<number | null>(null);

  // Lightweight badge: images in the current scope (project or user).
  const refreshImageCount = useCallback(async () => {
    try {
      const inProject = viewMode === "project-workspace" && activeProjectId;
      const items = inProject
        ? await fetchProjectImages(activeProjectId!)
        : await fetchUserImages();
      setImageCount(items.length);
    } catch {
      setImageCount(null);
    }
  }, [activeProjectId, viewMode]);

  useEffect(() => {
    setImageCount(null);
    void refreshImageCount();
  }, [refreshImageCount]);

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
            if (newChatDisabled) return;
            onNewChat();
            onCloseMobile?.();
          }}
          disabled={newChatDisabled}
          aria-label="New chat"
          title={
            newChatDisabled
              ? "Already on a new chat — send a message first"
              : "New chat"
          }
          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-text-muted disabled:active:scale-100"
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
        {/* Workspace nav — compact spacing (same as original menu rhythm) */}
        <div className="px-2 pb-2">
          <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-faint">
            Workspace
          </p>

          <button
            type="button"
            onClick={() => {
              onOpenAllChats();
              onCloseMobile?.();
            }}
            className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              viewMode === "standalone"
                ? "bg-white/[0.08] text-text"
                : "text-text-muted hover:bg-white/[0.05] hover:text-text"
            }`}
          >
            <MessagesSquare className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate font-medium">
              All chats
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onOpenProjects();
              onCloseMobile?.();
            }}
            className={`mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              viewMode === "projects-index"
                ? "bg-white/[0.08] text-text"
                : "text-text-muted hover:bg-white/[0.05] hover:text-text"
            }`}
          >
            <FolderKanban className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate font-medium">Projects</span>
          </button>

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

          <button
            type="button"
            onClick={() => {
              setGalleryOpen(true);
              onCloseMobile?.();
            }}
            aria-haspopup="dialog"
            className="mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] text-text-muted hover:bg-white/[0.05] hover:text-text"
          >
            <Images className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate font-medium">Images</span>
            {imageCount && imageCount > 0 ? (
              <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-text-muted">
                {imageCount}
              </span>
            ) : null}
          </button>
        </div>

        {/* Recent projects sit above date groups (TODAY / …), history-list style */}
        {visibleProjects.length > 0 ? (
          <div className="flex flex-col px-2.5">
            <section className="flex flex-col gap-0.5">
              <h3 className="sticky top-0 z-10 bg-transparent px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-faint">
                Recent projects
              </h3>
              <ul className="flex list-none flex-col gap-0.5 p-0">
                {visibleProjects.map((project, i) => {
                  const selected =
                    viewMode === "project-workspace" &&
                    activeProjectId === project.id;
                  return (
                    <li
                      key={project.id}
                      className="stagger-item"
                      style={{ ["--i" as string]: Math.min(i, 12) }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onOpenRecentProject(project);
                          onCloseMobile?.();
                        }}
                        title={project.name}
                        aria-current={selected ? "page" : undefined}
                        className={`flex w-full min-h-9 cursor-pointer items-center rounded-xl px-3.5 py-2.5 text-left text-[13px] leading-snug transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.99] ${
                          selected
                            ? "glass-pane font-medium text-text"
                            : "text-text-muted hover:bg-white/[0.035] hover:text-text"
                        }`}
                      >
                        <span className="truncate">{project.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        ) : null}

        <SessionHistoryList
          sessions={sessions}
          activeRuns={activeRuns}
          activeSessionId={
            viewMode === "standalone" || viewMode === "project-workspace"
              ? activeSessionId
              : ""
          }
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          /** Slightly more top pad when Recent projects sits above TODAY */
          firstGroupTopPad={visibleProjects.length > 0 ? "pt-2" : "pt-1"}
          onSelect={(id) => {
            onSelect(id);
            onCloseMobile?.();
          }}
          onLoadMore={onLoadMore}
          onRetry={onRetry}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onRemoveSession={onRemoveSession}
        />
      </div>

      <div className="shrink-0">
        <AccountMenu user={user} />
      </div>

      <ImageGalleryModal
        open={galleryOpen}
        onClose={() => {
          setGalleryOpen(false);
          // Keep the badge in sync with the latest list the modal loaded.
          void refreshImageCount();
        }}
        activeProjectId={activeProjectId}
      />
    </aside>
  );
}
