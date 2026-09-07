import {
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { AppShell } from "#/components/layout/app-shell";
import { ImagePreviewProvider, type ImagePreviewContextActions } from "#/components/images/image-preview";
import { WorkspaceSessionsContext } from "#/components/workspace/workspace-sessions-context";
import type { WorkspaceViewMode } from "#/components/sidebar/chat-sidebar";
import type { SessionUser } from "#/lib/auth-client";
import { useWorkspaceSessions } from "#/hooks/use-workspace-sessions";
import {
  ApiAuthError,
  deleteChatSession,
  getOrCreateEmptyChatSession,
  getProject,
  listProjects,
  listSessions,
  openProject,
  renameSession,
  type ProjectListItem,
} from "#/lib/api";
import { SharePopover } from "#/components/share/share-popover";
import { applyWorkspaceTitle } from "#/lib/document-title";
import {
  EMPTY_CHAT_TITLE,
  findEmptyNewChat,
  isEmptyNewChat,
  type SessionSummary,
} from "#/lib/session-history";
import {
  clearStoredSessionId,
  persistLastStandaloneSessionId,
  persistSessionId,
  readLastStandaloneSessionId,
} from "#/lib/session-storage";
import {
  projectNavigate,
  sessionNavigate,
} from "#/lib/workspace-urls";

const RECENT_PROJECTS_LIMIT = 5;

type WorkspaceParams = {
  projectId?: string;
  sessionId?: string;
};

function readParams(params: Record<string, unknown>): WorkspaceParams {
  return {
    projectId:
      typeof params.projectId === "string" ? params.projectId : undefined,
    sessionId:
      typeof params.sessionId === "string" ? params.sessionId : undefined,
  };
}

/**
 * Workspace shell: sidebar + title + session list shared by every workspace
 * route. The URL is the source of truth — selection state derives from route
 * params, and every sidebar action navigates instead of setting local view
 * state.
 */
export function WorkspaceShell({
  user,
  children,
}: {
  user: SessionUser;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = readParams(useParams({ strict: false }));

  const pathname = location.pathname;
  const inProjectsIndex = pathname === "/projects";
  const inDocumentsIndex = pathname === "/documents";
  const routeProjectId = params.projectId ?? null;
  const routeSessionId = params.sessionId ?? null;
  const inProjectChat = pathname.startsWith("/projects/") && routeSessionId !== null;

  const viewMode: WorkspaceViewMode = inProjectsIndex
    ? "projects-index"
    : inDocumentsIndex
      ? "documents-index"
      : routeProjectId
        ? "project-workspace"
        : "standalone";
  const activeProjectId = inProjectChat || routeProjectId ? routeProjectId : null;
  const scopeProjectId = viewMode === "project-workspace" ? activeProjectId : null;
  const activeSessionId = routeSessionId ?? "";

  const handleAuthFailure = useCallback(() => {
    void navigate({
      to: "/login",
      search: { redirect: `${pathname}${location.searchStr}` },
      viewTransition: true,
    });
  }, [location.searchStr, navigate, pathname]);

  const sessionsState = useWorkspaceSessions({
    projectId: scopeProjectId,
    activeSessionId,
    onAuthFailure: handleAuthFailure,
  });
  const {
    sessions,
    nextCursor,
    sessionsLoading,
    sessionsLoadingMore,
    sessionsError,
    activeRuns,
    loadFirstPage,
    loadMore,
    refreshQuiet,
    removeSession,
    renameSessionInList,
  } = sessionsState;

  const [recentProjects, setRecentProjects] = useState<ProjectListItem[]>([]);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [imageContextActions, setImageContextActions] =
    useState<ImagePreviewContextActions | null>(null);
  const [shareTarget, setShareTarget] = useState<SessionSummary | null>(null);
  const [sharedSessionIds, setSharedSessionIds] = useState<
    ReadonlySet<string>
  >(new Set());

  const refreshRecentProjects = useCallback(async () => {
    try {
      const page = await listProjects({
        limit: RECENT_PROJECTS_LIMIT,
        sort: "lastOpenedAt",
      });
      setRecentProjects(page.items);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        handleAuthFailure();
        return;
      }
      console.error("[projects] failed to load recent", error);
    }
  }, [handleAuthFailure]);

  useEffect(() => {
    void refreshRecentProjects();
  }, [refreshRecentProjects]);

  // Keep the active project name in sync with the route (topbar breadcrumb).
  useEffect(() => {
    if (viewMode !== "project-workspace" || !activeProjectId) {
      setActiveProjectName(null);
      setProjectError(null);
      return;
    }
    let cancelled = false;
    setProjectError(null);
    void (async () => {
      try {
        const project = await getProject(activeProjectId);
        if (cancelled) return;
        setActiveProjectName(project.name);
        void openProject(project.id).catch(() => {});
        void refreshRecentProjects();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        console.error("[workspace] load project failed", error);
        setActiveProjectName(null);
        setProjectError("Could not load project");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, handleAuthFailure, refreshRecentProjects, viewMode]);

  // Persist the active chat for the `/` redirector fallback.
  useEffect(() => {
    if (!activeSessionId) return;
    persistSessionId(activeSessionId);
    if (viewMode === "standalone") {
      persistLastStandaloneSessionId(activeSessionId);
    }
  }, [activeSessionId, viewMode]);

  const activeSessionTitle = useMemo(() => {
    return (
      sessions.find((s) => s.sessionId === activeSessionId)?.title?.trim() ||
      EMPTY_CHAT_TITLE
    );
  }, [activeSessionId, sessions]);

  const activeTitle = useMemo(() => {
    if (viewMode === "projects-index") return "Projects";
    if (viewMode === "documents-index") return "Documents";
    if (viewMode === "project-workspace" && activeProjectName) {
      return `${activeProjectName} · ${activeSessionTitle}`;
    }
    if (projectError && viewMode === "project-workspace") {
      return activeSessionTitle;
    }
    return activeSessionTitle;
  }, [activeProjectName, activeSessionTitle, projectError, viewMode]);

  useEffect(() => {
    applyWorkspaceTitle(activeTitle);
  }, [activeTitle]);

  const newChatDisabled = useMemo(() => {
    if (viewMode !== "standalone" && viewMode !== "project-workspace") {
      return false;
    }
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    const emptyDraft = active
      ? isEmptyNewChat(active)
      : activeSessionTitle === EMPTY_CHAT_TITLE;
    return emptyDraft && !activeRuns.has(activeSessionId);
  }, [activeRuns, activeSessionTitle, activeSessionId, sessions, viewMode]);

  // Typed pattern + params keeps this a client-side SPA navigation with
  // a real history entry (interpolating ids into `to` reloads the page).
  const navigateToSession = useCallback(
    (sessionId: string, projectId: string | null, replace = false) => {
      void navigate({
        ...sessionNavigate({ sessionId, projectId }),
        replace,
      });
    },
    [navigate],
  );

  const handleSelectSession = useCallback(
    (nextSessionId: string) => {
      if (nextSessionId === activeSessionId) return;
      if (viewMode === "project-workspace" && activeProjectId) {
        navigateToSession(nextSessionId, activeProjectId);
        return;
      }
      if (viewMode === "projects-index" || viewMode === "documents-index") {
        navigateToSession(nextSessionId, null);
        return;
      }
      navigateToSession(nextSessionId, scopeProjectId);
    },
    [activeProjectId, activeSessionId, navigateToSession, scopeProjectId, viewMode],
  );

  const handleNewSession = useCallback(() => {
    const projectId = scopeProjectId;
    if (viewMode === "standalone" || viewMode === "project-workspace") {
      const empty = findEmptyNewChat(sessions, activeRuns);
      if (empty && empty.sessionId !== activeSessionId) {
        navigateToSession(empty.sessionId, projectId);
        return;
      }
      if (empty) return;
    }
    void (async () => {
      try {
        const draft = await getOrCreateEmptyChatSession({ projectId });
        navigateToSession(draft.sessionId, projectId);
        void loadFirstPage();
      } catch (error) {
        console.error("[sessions] open empty draft failed", error);
      }
    })();
  }, [
    activeSessionId,
    activeRuns,
    loadFirstPage,
    navigateToSession,
    scopeProjectId,
    sessions,
    viewMode,
  ]);

  const handleOpenAllChats = useCallback(() => {
    if (viewMode === "standalone") return;
    const last = readLastStandaloneSessionId();
    if (last) {
      navigateToSession(last, null);
      return;
    }
    void (async () => {
      try {
        const draft = await getOrCreateEmptyChatSession({ projectId: null });
        navigateToSession(draft.sessionId, null);
      } catch (error) {
        console.error("[sessions] open standalone draft failed", error);
      }
    })();
  }, [navigate, navigateToSession, viewMode]);

  const handleOpenProjects = useCallback(() => {
    void navigate({ to: "/projects" });
  }, [navigate]);

  const handleOpenDocuments = useCallback(() => {
    void navigate({ to: "/documents" });
  }, [navigate]);

  const handleOpenProject = useCallback(
    (project: ProjectListItem) => {
      if (viewMode === "standalone" && activeSessionId) {
        persistLastStandaloneSessionId(activeSessionId);
      }
      void navigate(projectNavigate(project.id));
    },
    [activeSessionId, navigate, viewMode],
  );

  const handleRenameSession = useCallback(
    async (targetSessionId: string, title: string) => {
      try {
        const renamed = await renameSession(targetSessionId, title);
        renameSessionInList(targetSessionId, renamed.title);
      } catch (error) {
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        throw error;
      }
    },
    [handleAuthFailure, renameSessionInList],
  );

  const handleDeleteSession = useCallback(
    async (targetSessionId: string) => {
      try {
        await deleteChatSession(targetSessionId);
      } catch (error) {
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        throw error;
      }
      removeSession(targetSessionId);
      if (targetSessionId !== activeSessionId) return;
      if (viewMode !== "standalone" && viewMode !== "project-workspace") {
        clearStoredSessionId();
        return;
      }
      // Leave the deleted URL: replace with a sibling or a fresh draft.
      try {
        const page = await listSessions({
          limit: 30,
          projectId: scopeProjectId ?? undefined,
        });
        const rest = page.items.filter((s) => s.sessionId !== targetSessionId);
        const empty = findEmptyNewChat(rest, activeRuns);
        const replacement = empty ?? rest[0] ?? null;
        if (replacement) {
          navigateToSession(replacement.sessionId, scopeProjectId, true);
          return;
        }
        const draft = await getOrCreateEmptyChatSession({
          projectId: scopeProjectId,
        });
        navigateToSession(draft.sessionId, scopeProjectId, true);
      } catch (error) {
        console.error("[sessions] replacement after delete failed", error);
      }
    },
    [activeRuns, activeSessionId, handleAuthFailure, navigateToSession, removeSession, scopeProjectId, viewMode],
  );

  const handleRemoveSession = useCallback(
    (targetSessionId: string) => {
      removeSession(targetSessionId);
    },
    [removeSession],
  );

  const handleOpenShare = useCallback((session: SessionSummary) => {
    setShareTarget(session);
  }, []);

  const handleCloseShare = useCallback(() => {
    setShareTarget(null);
  }, []);

  const handleShareStatusChange = useCallback(
    (sessionId: string, active: boolean) => {
      setSharedSessionIds((current) => {
        if (active === current.has(sessionId)) return current;
        const next = new Set(current);
        if (active) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    },
    [],
  );

  const handleShareActiveChat = useCallback(() => {
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    if (active) setShareTarget(active);
  }, [activeSessionId, sessions]);

  const sessionsContextValue = useMemo(
    () => ({ refreshQuiet, onImageContextActions: setImageContextActions }),
    [refreshQuiet],
  );

  return (
    <WorkspaceSessionsContext.Provider value={sessionsContextValue}>
      <ImagePreviewProvider actions={imageContextActions}>
        <AppShell
          user={user}
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeRuns={activeRuns}
          activeTitle={activeTitle}
          sessionsLoading={sessionsLoading}
          sessionsLoadingMore={sessionsLoadingMore}
          sessionsError={sessionsError}
          hasMoreSessions={Boolean(nextCursor)}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewSession}
          newChatDisabled={newChatDisabled}
          onLoadMoreSessions={() => {
            void loadMore();
          }}
          onRetrySessions={() => {
            void loadFirstPage();
          }}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          onShareSession={handleOpenShare}
          onRemoveSession={handleRemoveSession}
          showCopyLink={
            viewMode === "standalone" || viewMode === "project-workspace"
          }
          showShare={
            viewMode === "standalone" || viewMode === "project-workspace"
          }
          shareActive={sharedSessionIds.has(activeSessionId)}
          onShare={handleShareActiveChat}
          viewMode={viewMode}
          recentProjects={recentProjects}
          activeProjectId={activeProjectId}
          onOpenAllChats={handleOpenAllChats}
          onOpenProjects={handleOpenProjects}
          onOpenDocuments={handleOpenDocuments}
          onOpenRecentProject={handleOpenProject}
        >
          {children}
        </AppShell>
      </ImagePreviewProvider>
      {shareTarget ? (
        <SharePopover
          sessionId={shareTarget.sessionId}
          sessionTitle={shareTarget.title?.trim() || EMPTY_CHAT_TITLE}
          open
          onClose={handleCloseShare}
          onStatusChange={handleShareStatusChange}
          onAuthFailure={handleAuthFailure}
        />
      ) : null}
    </WorkspaceSessionsContext.Provider>
  );
}
