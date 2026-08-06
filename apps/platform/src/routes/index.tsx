import {
  createChatTransport,
  initialMessagesFromMemory,
  useChat,
} from "@anvia/react";
import type { UIAttachment, UIMessage } from "@anvia/react";
import { ChatProvider, Composer, Thread } from "@anvia/react-ui";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ChatMessageRow } from "#/components/chat/chat-message-row";
import { CitationSessionProvider } from "#/components/chat/citation-session-context";
import { EmptyState } from "#/components/chat/empty-state";
import { InsetScrollbar } from "#/components/chat/inset-scrollbar";
import {
  SessionDocumentsRail,
  type IngestionItem,
} from "#/components/chat/session-documents-panel";
import { ChatComposer } from "#/components/composer/chat-composer";
import { AppShell } from "#/components/layout/app-shell";
import { DocChatMark } from "#/components/layout/doc-chat-mark";
import {
  API_BASE,
  ApiAuthError,
  getOrCreateEmptyChatSession,
  getProject,
  listProjects,
  listSessionDocuments,
  listSessions,
  loadChatMessages,
  openProject,
  truncateSessionMemory,
  unlinkDocumentFromSession,
  uploadDocument,
  waitForDocumentReady,
  type ProjectListItem,
  type SessionDocument,
} from "#/lib/api";
import { ProjectsBrowser } from "#/components/projects/projects-browser";
import { DocumentsBrowser } from "#/components/documents/documents-browser";
import { ImagePreviewProvider } from "#/components/images/image-preview";
import type { WorkspaceViewMode } from "#/components/sidebar/chat-sidebar";
import { collectCitedDocuments } from "#/lib/documents/cited-documents";
import { ensureUploadableFile } from "#/lib/documents/upload-file";
import { authClient, type SessionUser } from "#/lib/auth-client";
import {
  parseMessageCitations,
  validateCitationsAgainstSession,
} from "#/lib/chat/citations";
import {
  canTargetMessageForTruncate,
  readChatMessageMeta,
  withChatMessageMeta,
} from "#/lib/chat/message-metadata";
import { getMessageRawText } from "#/lib/chat/message-text";
import {
  EMPTY_CHAT_TITLE,
  findEmptyNewChat,
  isEmptyNewChat,
  sessionSummaryFromDraft,
  type SessionSummary,
} from "#/lib/session-history";
import {
  persistSelectedModel,
  persistSelectedReasoningEffort,
  readSelectedModel,
  readSelectedReasoningEffort,
} from "#/lib/chat-preferences";
import type {
  CompletionModelId,
  ReasoningEffort,
} from "#/lib/chat/models";
import {
  clearWorkspaceProjectState,
  persistLastStandaloneSessionId,
  persistSessionId,
  persistWorkspaceState,
  readLastStandaloneSessionId,
  readStoredSessionId,
  readWorkspaceState,
} from "#/lib/session-storage";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const SESSIONS_PAGE_SIZE = 30;

export const Route = createFileRoute("/")({
  component: Home,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data?.user) {
      throw redirect({ to: "/login", search: { redirect: "/" } });
    }
    return {
      user: {
        id: session.data.user.id,
        email: session.data.user.email,
        name: session.data.user.name,
        image: session.data.user.image ?? null,
      } satisfies SessionUser,
    };
  },
});

function documentIdsFromMetadata(metadata: UIMessage["metadata"]): string[] {
  return readChatMessageMeta(metadata).documentIds ?? [];
}

function createClientMessageId() {
  return crypto.randomUUID();
}

async function resolveAttachmentFile(attachment: UIAttachment) {
  if (attachment.url?.startsWith("blob:")) {
    const response = await fetch(attachment.url);
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Attachment is empty: ${attachment.name ?? attachment.id}`);
    }
    return ensureUploadableFile(
      new File([blob], attachment.name ?? "document", {
        type: attachment.mediaType ?? "application/octet-stream",
      }),
    );
  }

  if (attachment.data) {
    const dataUrl = attachment.data.startsWith("data:")
      ? attachment.data
      : `data:${attachment.mediaType ?? "application/octet-stream"};base64,${attachment.data}`;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Attachment is empty: ${attachment.name ?? attachment.id}`);
    }
    return ensureUploadableFile(
      new File([blob], attachment.name ?? "document", {
        type: attachment.mediaType ?? (blob.type || "application/octet-stream"),
      }),
    );
  }

  throw new Error(`Unable to read attachment: ${attachment.name ?? attachment.id}`);
}

function Home() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const initialWorkspace = useMemo(() => readWorkspaceState(), []);
  // Prefer stored id; empty means "resolve via list/draft" (never invent UUIDs).
  const [sessionId, setSessionId] = useState(() => {
    return readStoredSessionId() ?? "";
  });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(
    null,
  );
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>(
    () => initialWorkspace.viewMode,
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    () => initialWorkspace.activeProjectId,
  );
  const [activeProjectName, setActiveProjectName] = useState<string | null>(
    () => initialWorkspace.activeProjectName,
  );
  const [recentProjects, setRecentProjects] = useState<ProjectListItem[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(
    () => initialWorkspace.viewMode !== "project-workspace",
  );
  const loadMoreLock = useRef(false);
  // Always read latest sessionId inside async callbacks without re-creating loaders.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  const handleAuthFailure = useCallback(() => {
    void navigate({ to: "/login", search: { redirect: "/" } });
  }, [navigate]);

  const refreshRecentProjects = useCallback(async () => {
    try {
      const page = await listProjects({ limit: 5, sort: "lastOpenedAt" });
      setRecentProjects(page.items);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        handleAuthFailure();
        return;
      }
      console.error("[projects] failed to load recent", error);
    }
  }, [handleAuthFailure]);

  const loadSessionsFirstPage = useCallback(async () => {
    const activeId = sessionIdRef.current;
    const inProject = viewModeRef.current === "project-workspace";
    const inStandalone = viewModeRef.current === "standalone";
    const projectId = inProject ? activeProjectIdRef.current : null;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const page = await listSessions({
        limit: SESSIONS_PAGE_SIZE,
        projectId: projectId ?? undefined,
      });
      let items = page.items;
      setNextCursor(page.nextCursor);

      // In chat views: active session must belong to this list. Never invent
      // phantom drafts (that stacked "New chat" when switching project↔all).
      if (inProject || inStandalone) {
        const activeInList = items.some((s) => s.sessionId === activeId);
        if (!activeInList) {
          const empty = findEmptyNewChat(items);
          if (empty) {
            setSessionId(empty.sessionId);
          } else if (items[0]) {
            setSessionId(items[0].sessionId);
          } else {
            const draft = await getOrCreateEmptyChatSession({
              projectId: inProject ? projectId : null,
            });
            const row = sessionSummaryFromDraft(draft);
            items = [row];
            setSessionId(draft.sessionId);
            setNextCursor(null);
          }
        }
      }

      setSessions(items);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        handleAuthFailure();
        return;
      }
      console.error("[sessions] failed to load", error);
      setSessionsError("Could not load conversations");
    } finally {
      setSessionsLoading(false);
    }
  }, [handleAuthFailure]);

  const loadMoreSessions = useCallback(async () => {
    if (!nextCursor || loadMoreLock.current || sessionsLoadingMore) return;
    loadMoreLock.current = true;
    setSessionsLoadingMore(true);
    try {
      const projectId =
        viewModeRef.current === "project-workspace"
          ? activeProjectIdRef.current
          : null;
      const page = await listSessions({
        cursor: nextCursor,
        limit: SESSIONS_PAGE_SIZE,
        projectId: projectId ?? undefined,
      });
      setSessions((current) => {
        const seen = new Set(current.map((s) => s.sessionId));
        const appended = page.items.filter((s) => !seen.has(s.sessionId));
        return [...current, ...appended];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      console.error("[sessions] failed to load more", error);
    } finally {
      setSessionsLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [nextCursor, sessionsLoadingMore]);

  /** After a stream ends, refresh titles/order from the server only. */
  const refreshSessionsQuiet = useCallback(async () => {
    const projectId =
      viewModeRef.current === "project-workspace"
        ? activeProjectIdRef.current
        : null;
    try {
      const page = await listSessions({
        limit: SESSIONS_PAGE_SIZE,
        projectId: projectId ?? undefined,
      });
      setSessions(page.items);
      setNextCursor(page.nextCursor);
      setSessionsError(null);
    } catch (error) {
      console.error("[sessions] quiet refresh failed", error);
    }
  }, []);

  // Validate restored project workspace once on mount (B2).
  useEffect(() => {
    if (initialWorkspace.viewMode !== "project-workspace") {
      return;
    }
    const projectId = initialWorkspace.activeProjectId;
    if (!projectId) {
      setViewMode("standalone");
      setActiveProjectId(null);
      setActiveProjectName(null);
      clearWorkspaceProjectState();
      setWorkspaceReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const project = await getProject(projectId);
        if (cancelled) return;
        setActiveProjectId(project.id);
        setActiveProjectName(project.name);
        setViewMode("project-workspace");
        void openProject(project.id).catch(() => {
          // lastOpenedAt touch is best-effort
        });
      } catch (error) {
        if (cancelled) return;
        console.error("[workspace] restore project failed", error);
        setViewMode("standalone");
        setActiveProjectId(null);
        setActiveProjectName(null);
        clearWorkspaceProjectState();
        const lastStandalone = readLastStandaloneSessionId();
        if (lastStandalone) {
          setSessionId(lastStandalone);
        } else {
          try {
            const draft = await getOrCreateEmptyChatSession({
              projectId: null,
            });
            if (!cancelled) {
              setSessionId(draft.sessionId);
              persistLastStandaloneSessionId(draft.sessionId);
            }
          } catch {
            // loadSessionsFirstPage will recover a draft
          }
        }
      } finally {
        if (!cancelled) setWorkspaceReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally once on mount from stored workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist workspace chrome for reload restore.
  useEffect(() => {
    persistWorkspaceState({
      viewMode,
      activeProjectId,
      activeProjectName,
    });
  }, [viewMode, activeProjectId, activeProjectName]);

  // Recent projects once on mount.
  useEffect(() => {
    void refreshRecentProjects();
  }, [refreshRecentProjects]);

  // Single driver for session list (avoids double-fetch on mount).
  useEffect(() => {
    if (!workspaceReady) return;
    void loadSessionsFirstPage();
  }, [viewMode, activeProjectId, loadSessionsFirstPage, workspaceReady]);

  // Load messages whenever the active session changes (chat views only).
  useEffect(() => {
    if (!workspaceReady) return;
    if (viewMode !== "standalone" && viewMode !== "project-workspace") {
      return;
    }
    if (!sessionId) {
      setInitialMessages([]);
      return;
    }
    persistSessionId(sessionId);
    if (viewMode === "standalone") {
      persistLastStandaloneSessionId(sessionId);
    }
    let cancelled = false;
    setInitialMessages(null);

    void (async () => {
      try {
        const data = await loadChatMessages(sessionId);
        if (!cancelled) {
          setInitialMessages(initialMessagesFromMemory(data as never));
        }
      } catch (error) {
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        if (!cancelled) {
          setInitialMessages([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handleAuthFailure, sessionId, viewMode, workspaceReady]);

  const enterStandaloneWorkspace = useCallback(
    (nextSessionId?: string) => {
      setActiveProjectId(null);
      setActiveProjectName(null);
      setViewMode("standalone");
      clearWorkspaceProjectState();

      if (nextSessionId) {
        setSessionId(nextSessionId);
        persistLastStandaloneSessionId(nextSessionId);
        return;
      }

      const last = readLastStandaloneSessionId();
      if (last) {
        setSessionId(last);
        return;
      }

      // No remembered standalone chat — open the single empty draft (no invent).
      void (async () => {
        try {
          const draft = await getOrCreateEmptyChatSession({ projectId: null });
          setSessionId(draft.sessionId);
          persistLastStandaloneSessionId(draft.sessionId);
          setSessions([sessionSummaryFromDraft(draft)]);
          setNextCursor(null);
        } catch (error) {
          console.error("[sessions] open standalone draft failed", error);
        }
      })();
    },
    [],
  );

  const handleSelectSession = (nextSessionId: string) => {
    if (
      viewMode !== "standalone" &&
      viewMode !== "project-workspace"
    ) {
      // Selecting a chat from browser views enters the matching mode.
      if (activeProjectId) {
        setViewMode("project-workspace");
      } else {
        setViewMode("standalone");
      }
    }
    if (nextSessionId === sessionId && (viewMode === "standalone" || viewMode === "project-workspace")) {
      return;
    }
    setSessionId(nextSessionId);
    if (viewMode === "standalone" || viewMode === "projects-index" || viewMode === "documents-index") {
      persistLastStandaloneSessionId(nextSessionId);
    }
    if (viewMode === "projects-index" || viewMode === "documents-index") {
      // Prefer standalone when selecting from history while browsing.
      setActiveProjectId(null);
      setActiveProjectName(null);
      setViewMode("standalone");
    }
  };

  const handleNewSession = () => {
    const inProject =
      viewMode === "project-workspace" && Boolean(activeProjectId);
    const projectId = inProject ? activeProjectId : null;

    // Prefer client-visible empty draft first (fast path).
    if (viewMode === "standalone" || viewMode === "project-workspace") {
      const empty = findEmptyNewChat(sessions);
      if (empty) {
        if (empty.sessionId !== sessionId) {
          setSessionId(empty.sessionId);
          if (!inProject) persistLastStandaloneSessionId(empty.sessionId);
        }
        return;
      }
    }

    // Server is source of truth: one empty draft per scope; prunes duplicates.
    void (async () => {
      try {
        if (!inProject && viewMode !== "standalone") {
          setActiveProjectId(null);
          setActiveProjectName(null);
          setViewMode("standalone");
        }
        const draft = await getOrCreateEmptyChatSession({ projectId });
        setSessionId(draft.sessionId);
        if (!inProject) {
          persistLastStandaloneSessionId(draft.sessionId);
        }
        setSessionsError(null);
        void loadSessionsFirstPage();
      } catch (error) {
        console.error("[sessions] open empty draft failed", error);
        setSessionsError(
          error instanceof Error
            ? error.message
            : "Could not open a new chat",
        );
      }
    })();
  };

  const handleOpenAllChats = useCallback(() => {
    if (viewModeRef.current === "standalone") {
      // Already in all-chats; keep current session.
      return;
    }
    // Leaving a project chat: restore last standalone (or single empty draft).
    enterStandaloneWorkspace();
  }, [enterStandaloneWorkspace]);

  const handleOpenProjects = () => {
    if (viewMode === "standalone") {
      persistLastStandaloneSessionId(sessionId);
    }
    setViewMode("projects-index");
  };

  const handleOpenDocuments = () => {
    if (viewMode === "standalone") {
      persistLastStandaloneSessionId(sessionId);
    }
    setViewMode("documents-index");
  };

  const handleProjectDeleted = useCallback(
    (projectId: string) => {
      void refreshRecentProjects();
      if (activeProjectIdRef.current === projectId) {
        enterStandaloneWorkspace();
      }
    },
    [enterStandaloneWorkspace, refreshRecentProjects],
  );

  const handleOpenProject = useCallback(
    (project: ProjectListItem) => {
      if (viewModeRef.current === "standalone") {
        persistLastStandaloneSessionId(sessionIdRef.current);
      }
      setActiveProjectId(project.id);
      setActiveProjectName(project.name);
      setViewMode("project-workspace");
      setSessionsError(null);
      void openProject(project.id)
        .then((opened) => {
          setActiveProjectName(opened.name);
          void refreshRecentProjects();
        })
        .catch((error) => {
          console.error("[projects] open failed", error);
        });

      void (async () => {
        try {
          const page = await listSessions({
            limit: SESSIONS_PAGE_SIZE,
            projectId: project.id,
          });
          if (page.items.length > 0) {
            // Prefer existing empty draft in this project, else most recent chat.
            const empty = findEmptyNewChat(page.items);
            const pick = empty ?? page.items[0]!;
            setSessionId(pick.sessionId);
            setSessions(page.items);
            setNextCursor(page.nextCursor);
          } else {
            // Exactly one empty draft for the project (server reuses/prunes).
            const draft = await getOrCreateEmptyChatSession({
              projectId: project.id,
            });
            setSessionId(draft.sessionId);
            setSessions([sessionSummaryFromDraft(draft)]);
            setNextCursor(null);
          }
        } catch (error) {
          console.error("[projects] load project chats failed", error);
          setSessionsError(
            error instanceof Error
              ? error.message
              : "Could not open project chats",
          );
          setSessions([]);
          setNextCursor(null);
          setViewMode("projects-index");
          setActiveProjectId(null);
          setActiveProjectName(null);
        }
      })();
    },
    [refreshRecentProjects],
  );

  const activeSessionTitle = useMemo(() => {
    return (
      sessions.find((s) => s.sessionId === sessionId)?.title?.trim() ||
      EMPTY_CHAT_TITLE
    );
  }, [sessionId, sessions]);

  const activeTitle = useMemo(() => {
    if (viewMode === "projects-index") return "Projects";
    if (viewMode === "documents-index") return "Documents";
    if (viewMode === "project-workspace" && activeProjectName) {
      return `${activeProjectName} · ${activeSessionTitle}`;
    }
    return activeSessionTitle;
  }, [activeProjectName, activeSessionTitle, viewMode]);

  /**
   * Disable New chat only when already viewing an empty draft.
   * From a filled chat, New chat reuses another empty draft or creates one.
   */
  const newChatDisabled = useMemo(() => {
    if (viewMode !== "standalone" && viewMode !== "project-workspace") {
      return false;
    }
    const active = sessions.find((s) => s.sessionId === sessionId);
    return active ? isEmptyNewChat(active) : activeSessionTitle === EMPTY_CHAT_TITLE;
  }, [activeSessionTitle, sessionId, sessions, viewMode]);

  const showChatRoom =
    workspaceReady &&
    (viewMode === "standalone" || viewMode === "project-workspace");

  return (
    <ImagePreviewProvider>
      <AppShell
        user={user}
        sessions={sessions}
        activeSessionId={sessionId}
        activeTitle={activeTitle}
        sessionsLoading={sessionsLoading || !workspaceReady}
        sessionsLoadingMore={sessionsLoadingMore}
        sessionsError={sessionsError}
        hasMoreSessions={Boolean(nextCursor)}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewSession}
        newChatDisabled={newChatDisabled}
        onLoadMoreSessions={() => {
          void loadMoreSessions();
        }}
        onRetrySessions={() => {
          void loadSessionsFirstPage();
        }}
        viewMode={viewMode}
        recentProjects={recentProjects}
        activeProjectId={activeProjectId}
        onOpenAllChats={handleOpenAllChats}
        onOpenProjects={handleOpenProjects}
        onOpenDocuments={handleOpenDocuments}
        onOpenRecentProject={handleOpenProject}
      >
        {!workspaceReady ? (
          <div
            key="workspace-loading"
            className="flex flex-1 flex-col items-center justify-center gap-3 animate-fade-up"
          >
            <DocChatMark className="opacity-80" />
            <div className="skeleton-shimmer h-4 w-40 rounded-full" />
            <p className="text-sm text-text-muted">Restoring workspace…</p>
          </div>
        ) : null}

        {workspaceReady && viewMode === "projects-index" ? (
          <ProjectsBrowser
            key="workspace-projects"
            activeProjectId={activeProjectId}
            onOpenProject={handleOpenProject}
            onProjectDeleted={handleProjectDeleted}
          />
        ) : null}

        {workspaceReady && viewMode === "documents-index" ? (
          <DocumentsBrowser key="workspace-documents" />
        ) : null}

        {showChatRoom ? (
          initialMessages === null ? (
            <div
              key="chat-loading"
              className="flex flex-1 flex-col items-center justify-center gap-3 animate-fade-up"
            >
              <DocChatMark className="opacity-80" />
              <div className="skeleton-shimmer h-4 w-40 rounded-full" />
              <p className="text-sm text-text-muted">Loading conversation…</p>
            </div>
          ) : (
            <div
              key={`chat-shell-${activeProjectId ?? "standalone"}:${sessionId}`}
              className="flex min-h-0 flex-1 flex-col animate-fade-up"
            >
              <ChatSession
                sessionId={sessionId}
                projectId={
                  viewMode === "project-workspace" ? activeProjectId : null
                }
                initialMessages={initialMessages}
                onStreamSettled={() => {
                  void refreshSessionsQuiet();
                }}
                onAuthFailure={handleAuthFailure}
              />
            </div>
          )
        ) : null}
      </AppShell>
    </ImagePreviewProvider>
  );
}

function ChatSession({
  sessionId,
  projectId,
  initialMessages,
  onStreamSettled,
  onAuthFailure,
}: {
  sessionId: string;
  projectId?: string | null;
  initialMessages: UIMessage[];
  onStreamSettled: () => void;
  onAuthFailure: () => void;
}) {
  const composerInputRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);
  const [ingestionItems, setIngestionItems] = useState<IngestionItem[]>([]);
  const [sessionDocuments, setSessionDocuments] = useState<SessionDocument[]>(
    [],
  );
  const [removingDocumentId, setRemovingDocumentId] = useState<string | null>(
    null,
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<CompletionModelId>(() =>
    readSelectedModel(),
  );
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<ReasoningEffort>(() => readSelectedReasoningEffort());
  /** Latest model/effort for createRequest (avoids stale closures). */
  const selectedModelRef = useRef(selectedModel);
  const selectedReasoningEffortRef = useRef(selectedReasoningEffort);
  selectedModelRef.current = selectedModel;
  selectedReasoningEffortRef.current = selectedReasoningEffort;
  /** Shared with doc rail so its bottom band matches the textfield dock. */
  const [composerDockH, setComposerDockH] = useState(120);

  useEffect(() => {
    const el = composerDockRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === "number" && h > 0) setComposerDockH(Math.ceil(h));
    });
    ro.observe(el);
    setComposerDockH(Math.ceil(el.getBoundingClientRect().height));
    return () => ro.disconnect();
  }, []);

  const refreshSessionDocuments = useCallback(async () => {
    try {
      const documents = await listSessionDocuments(sessionId);
      setSessionDocuments(documents);
    } catch {
      // Keep the previous list if refresh fails.
    }
  }, [sessionId]);

  const sessionDocumentIds = useMemo(
    () => new Set(sessionDocuments.map((doc) => doc.id)),
    [sessionDocuments],
  );

  const handleLinkedDocuments = useCallback((documents: SessionDocument[]) => {
    setSessionDocuments(documents);
  }, []);

  const handleRemoveActiveDocument = useCallback(
    async (documentId: string) => {
      setRemovingDocumentId(documentId);
      try {
        await unlinkDocumentFromSession({ sessionId, documentId });
        setSessionDocuments((current) =>
          current.filter((doc) => doc.id !== documentId),
        );
      } finally {
        setRemovingDocumentId(null);
      }
    },
    [sessionId],
  );

  const chatTransport = useMemo(
    () =>
      createChatTransport({
        endpoint: `${API_BASE}/api/chat`,
        format: "jsonl",
        init: { credentials: "include" },
        body: (request) => JSON.stringify(request),
        headers: { "content-type": "application/json" },
      }),
    [],
  );

  const chat = useChat({
    transport: chatTransport,
    initialMessages,
    createRequest: ({ coreMessages, uiMessages }) => {
      const last = uiMessages.at(-1);
      const documentIds = documentIdsFromMetadata(last?.metadata);

      return {
        messages: coreMessages,
        stream: true as const,
        sessionId,
        documentIds,
        model: selectedModelRef.current,
        reasoningEffort: selectedReasoningEffortRef.current,
      };
    },
    onError: (error) => {
      if (error instanceof ApiAuthError) {
        onAuthFailure();
      }
    },
  });

  const handleModelChange = useCallback((model: CompletionModelId) => {
    setSelectedModel(model);
    persistSelectedModel(model);
  }, []);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setSelectedReasoningEffort(effort);
    persistSelectedReasoningEffort(effort);
  }, []);

  const focusComposer = useCallback(() => {
    let attempts = 0;

    const tryFocus = () => {
      const editor = composerInputRef.current?.querySelector<HTMLElement>(
        "[data-anvia-composer-editor]",
      );
      if (editor) {
        editor.focus();
        return;
      }
      if (attempts++ < 20) {
        requestAnimationFrame(tryFocus);
      }
    };

    tryFocus();
  }, []);

  useEffect(() => {
    if (wasStreamingRef.current && chat.status !== "streaming") {
      // Stamp createdAt + dual-write citations on the latest assistant turn.
      const sessionDocIds = new Set(sessionDocuments.map((d) => d.id));
      chat.setMessages((messages) => {
        const last = messages.at(-1);
        if (!last || last.role !== "assistant") return messages;

        const existing = readChatMessageMeta(last.metadata);
        const rawText = getMessageRawText(last);
        const parsed = parseMessageCitations(rawText).citations;
        const citations =
          parsed.length > 0
            ? validateCitationsAgainstSession(parsed, sessionDocIds)
            : existing.citations;

        const needsCreatedAt = !existing.createdAt;
        const needsCitations =
          citations !== undefined &&
          citations.length > 0 &&
          (!existing.citations || existing.citations.length === 0);

        if (!needsCreatedAt && !needsCitations) return messages;

        return messages.map((message, index) =>
          index === messages.length - 1
            ? {
                ...message,
                metadata: withChatMessageMeta(message.metadata, {
                  ...(needsCreatedAt
                    ? { createdAt: new Date().toISOString() }
                    : {}),
                  ...(needsCitations ? { citations } : {}),
                }),
              }
            : message,
        );
      });
      onStreamSettled();
      focusComposer();
    }
    wasStreamingRef.current = chat.status === "streaming";
  }, [
    chat.setMessages,
    chat.status,
    focusComposer,
    onStreamSettled,
    sessionDocuments,
  ]);

  useEffect(() => {
    focusComposer();
  }, [focusComposer]);

  useEffect(() => {
    setSessionDocuments([]);
    setIngestionItems([]);
    setComposerError(null);
    setIsIngesting(false);
    void refreshSessionDocuments();
  }, [refreshSessionDocuments]);

  useEffect(() => {
    setEditingMessageId(null);
  }, [sessionId]);

  /**
   * Shared path for revert (same text) and edit (new text):
   * truncate memory to exclude the target user message, drop later UI messages,
   * then send a fresh user turn so the agent appends a single clean prompt.
   */
  const resubmitFromUserMessage = useCallback(
    async (message: UIMessage, text: string) => {
      if (chat.status === "streaming") {
        throw new Error("Wait for the current reply to finish");
      }

      const index = chat.messages.findIndex((item) => item.id === message.id);
      if (index === -1) {
        throw new Error("Message is no longer in this conversation");
      }

      const meta = readChatMessageMeta(message.metadata);
      if (!canTargetMessageForTruncate(meta)) {
        throw new Error("This message cannot be regenerated yet");
      }

      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Message cannot be empty");
      }

      await truncateSessionMemory({
        sessionId,
        mode: "exclude",
        memoryPosition: meta.memoryPosition,
        clientMessageId: meta.clientMessageId,
      });

      chat.setMessages(chat.messages.slice(0, index));
      setEditingMessageId(null);

      await chat.sendMessage({
        text: trimmed,
        metadata: withChatMessageMeta(undefined, {
          sessionId,
          documentIds: meta.documentIds ?? [],
          createdAt: new Date().toISOString(),
          clientMessageId: createClientMessageId(),
        }),
      });
    },
    [chat, sessionId],
  );

  const handleRevert = useCallback(
    async (message: UIMessage) => {
      await resubmitFromUserMessage(message, getMessageRawText(message));
    },
    [resubmitFromUserMessage],
  );

  const handleSubmitEdit = useCallback(
    async (message: UIMessage, text: string) => {
      await resubmitFromUserMessage(message, text);
    },
    [resubmitFromUserMessage],
  );

  const citedDocuments = useMemo(
    () => collectCitedDocuments(chat.messages),
    [chat.messages],
  );

  return (
    <ChatProvider controller={chat}>
      <CitationSessionProvider sessionDocuments={sessionDocuments}>
      {/*
        Composer.Root wraps chat + right doc rail so attachments share context.
        When docs exist, rail opens (272px = left sidebar) and pushes chat left.
      */}
      <Composer.Root
        className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
        submitMessage={async ({
          input,
          attachments,
          chat: chatController,
          clear,
        }) => {
          setComposerError(null);
          const trimmed = input.trim();
          if (!trimmed && attachments.length === 0) return;

          const documentIds: string[] = [];

          // Local "Upload from computer" queues on composer; ingest only on submit.
          if (attachments.length > 0) {
            setIsIngesting(true);
            setIngestionItems([]);

            try {
              for (const attachment of attachments) {
                const file = await resolveAttachmentFile(attachment);
                if (file.size === 0) {
                  throw new Error(`File is empty: ${file.name}`);
                }

                const itemId = attachment.id || crypto.randomUUID();
                setIngestionItems((current) => [
                  ...current,
                  { id: itemId, filename: file.name, status: "uploading" },
                ]);

                const uploaded = await uploadDocument({
                  sessionId,
                  file,
                  projectId,
                });

                const ready = await waitForDocumentReady({
                  sessionId,
                  documentId: uploaded.id,
                  onStatus: (status) => {
                    setIngestionItems((current) =>
                      current.map((item) =>
                        item.id === itemId
                          ? { ...item, status: status.status }
                          : item,
                      ),
                    );
                  },
                });

                documentIds.push(ready.id);
              }

              await refreshSessionDocuments();
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : "Document processing failed";
              setComposerError(message);
              setIngestionItems((current) =>
                current.map((item) =>
                  item.status === "uploading" ||
                  item.status === "queued" ||
                  item.status === "ocr_processing" ||
                  item.status === "embedding_processing"
                    ? { ...item, status: "failed" }
                    : item,
                ),
              );
              setIsIngesting(false);
              return;
            }

            setIsIngesting(false);
          }

          const attachedDocuments = attachments.map((attachment) => {
            const name = attachment.name ?? "Document";
            return attachment.mediaType
              ? { name, mediaType: attachment.mediaType }
              : { name };
          });

          await chatController.sendMessage({
            text: trimmed,
            metadata: withChatMessageMeta(undefined, {
              sessionId,
              documentIds,
              attachedDocuments,
              createdAt: new Date().toISOString(),
              clientMessageId: createClientMessageId(),
            }),
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              type: attachment.type,
              name: attachment.name,
              mediaType: attachment.mediaType,
              text: attachment.name ?? "Document",
            })),
          });

          clear();
          setIngestionItems([]);
        }}
      >
        <div
          className="flex min-h-0 w-full flex-1 items-stretch overflow-hidden"
          style={
            {
              ["--composer-dock-h" as string]: `${composerDockH}px`,
              // Gap above textfield (last bubble → field); top chrome stays 24px
              ["--chat-composer-gap" as string]: "40px",
            } as CSSProperties
          }
        >
          {/* Center chat column — shrinks when right rail opens */}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <Thread.Root className="absolute inset-0 overflow-hidden">
              {/*
                Full-bleed scroll: content passes under top bar + textfield.
                Native scrollbar hidden; InsetScrollbar insets from top bar
                and above the textfield (see --chat-composer-gap).
              */}
              <Thread.Viewport
                ref={chatViewportRef}
                className="chat-scroll-bleed absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
                autoScroll
              >
                <div
                  className="mx-auto flex min-h-full w-full min-w-0 max-w-[760px] flex-col px-3"
                  style={{
                    paddingTop: "calc(3.5rem + 24px)",
                    paddingBottom:
                      "calc(var(--composer-dock-h, 7.5rem) + var(--chat-composer-gap, 40px))",
                  }}
                >
                  <Thread.Empty className="flex min-h-0 flex-1 flex-col">
                    <EmptyState />
                  </Thread.Empty>

                  <Thread.Suggestions className="mb-4 flex w-full flex-wrap gap-2" />

                  {/*
                    Same-thread vs cross-message spacing:
                    - activity chain (tool↔reasoning, any message split): tight mt-1
                    - only jump to a message that *starts with answer text*: mt-4
                    - around user turns: mt-4
                  */}
                  <Thread.Messages
                    className={[
                      "flex w-full min-w-0 flex-col",
                      "[&>*]:min-w-0",
                      "[&>*+*]:mt-1",
                      "[&>[data-activity-only]+[data-role=assistant]:not([data-starts-activity])]:mt-4",
                      "[&>[data-role=tool]+[data-role=assistant]:not([data-starts-activity])]:mt-4",
                      "[&>[data-role=user]+*]:mt-4",
                      "[&>*+[data-role=user]]:mt-4",
                    ].join(" ")}
                  >
                    {() => (
                      <ChatMessageRow
                        chatStatus={chat.status}
                        lastMessageId={chat.messages.at(-1)?.id}
                        editingMessageId={editingMessageId}
                        onStartEdit={(message) => {
                          if (chat.status === "streaming") return;
                          setEditingMessageId(message.id);
                        }}
                        onCancelEdit={() => setEditingMessageId(null)}
                        onSubmitEdit={handleSubmitEdit}
                        onRevert={handleRevert}
                      />
                    )}
                  </Thread.Messages>

                  <Thread.Loading className="mt-4 w-full text-sm text-text-muted">
                    {chat.status === "streaming"
                      ? "Thinking and writing…"
                      : "Writing…"}
                  </Thread.Loading>

                  <Thread.Error className="mt-4 w-full rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger" />
                </div>
              </Thread.Viewport>

              <InsetScrollbar
                scrollRef={chatViewportRef}
                top="calc(3.5rem + 24px)"
                bottom="calc(var(--composer-dock-h, 7.5rem) + var(--chat-composer-gap, 40px))"
              />

              {/* Overlay dock — content scrolls underneath */}
              <div
                ref={composerDockRef}
                className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-3"
              >
                <div className="pointer-events-auto relative mx-auto w-full max-w-[760px] px-3">
                  <Thread.ViewportFooter className="pointer-events-none absolute inset-x-3 bottom-full mb-2 flex justify-center">
                    <Thread.ScrollToBottom className="pointer-events-auto glass glass-interactive inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98] data-[state=bottom]:invisible">
                      Latest
                    </Thread.ScrollToBottom>
                  </Thread.ViewportFooter>

                  <ChatComposer
                    sessionId={sessionId}
                    projectId={projectId}
                    activeDocumentIds={sessionDocumentIds}
                    chatStatus={chat.status}
                    isIngesting={isIngesting}
                    composerError={composerError}
                    composerInputRef={composerInputRef}
                    model={selectedModel}
                    reasoningEffort={selectedReasoningEffort}
                    onModelChange={handleModelChange}
                    onReasoningChange={handleReasoningChange}
                    onLinkedDocuments={handleLinkedDocuments}
                  />
                </div>
              </div>
            </Thread.Root>
          </div>

          {/* Right doc rail — same 272px + full height as left sidebar */}
          <SessionDocumentsRail
            sessionDocuments={sessionDocuments}
            citedDocuments={citedDocuments}
            ingestionItems={ingestionItems}
            onRemoveActiveDocument={handleRemoveActiveDocument}
            removingDocumentId={removingDocumentId}
          />
        </div>
      </Composer.Root>
      </CitationSessionProvider>
    </ChatProvider>
  );
}
