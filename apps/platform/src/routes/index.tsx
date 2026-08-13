import {
  createChatTransport,
  EventStreamHttpError,
  initialMessagesFromMemory,
  useChat,
} from "@anvia/react";
import type { UIAttachment, UIMessage, UIMessagePart } from "@anvia/react";
import { ChatProvider, Composer, Thread } from "@anvia/react-ui";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { AnimatedStatusText } from "#/components/chat/animated-status-text";
import { ApprovalPanel } from "#/components/chat/approval-panel";
import { ChatMessageRow } from "#/components/chat/chat-message-row";
import { CitationSessionProvider } from "#/components/chat/citation-session-context";
import { ClarificationPanel } from "#/components/chat/clarification-panel";
import { EmptyState } from "#/components/chat/empty-state";
import { InsetScrollbar } from "#/components/chat/inset-scrollbar";
import { QueueConflictDialog } from "#/components/chat/queue-conflict-dialog";
import { StaleSessionDialog } from "#/components/chat/stale-session-dialog";
import {
  SessionDocumentsRail,
  type IngestionItem,
} from "#/components/chat/session-documents-panel";
import { ChatComposer } from "#/components/composer/chat-composer";
import { AppShell } from "#/components/layout/app-shell";
import { DocChatMark } from "#/components/layout/doc-chat-mark";
import type { AttachmentReject } from "#/lib/documents/upload-file";
import {
  API_BASE,
  ApiAuthError,
  decideApproval,
  deleteChatSession,
  fetchContextUsage,
  fetchRunStatus,
  fetchChatCapabilities,
  getOrCreateEmptyChatSession,
  getProject,
  listActiveRuns,
  listProjects,
  listSessionDocuments,
  listSessions,
  markSessionRead,
  loadChatMessages,
  openProject,
  renameSession,
  stopChatRun,
  truncateSessionMemory,
  unlinkDocumentFromSession,
  uploadDocument,
  uploadSessionImage,
  isImageAttachmentLike,
  imageDimensionsFromFile,
  waitForDocumentReady,
  fetchSessionImages,
  fetchSessionImageContexts,
  fetchSessionState,
  addSessionImageContext,
  removeSessionImageContext,
  fetchImageBytes,
  isSteerNoActiveRunError,
  steerChatMessages,
  syncQueuedMessageIds,
  type ContextUsageInfo,
  type GeneratedImageMeta,
  type ImageGenSettings,
  type ModelInfo,
  type ProjectListItem,
  type ReasoningEffortInfo,
  type SessionDocument,
  type SteerMessageInput,
  type WebCapabilities,
} from "#/lib/api";
import { ProjectsBrowser } from "#/components/projects/projects-browser";
import { DocumentsBrowser } from "#/components/documents/documents-browser";
import { ImagePreviewProvider, type ImagePreviewContextActions } from "#/components/images/image-preview";
import type { WorkspaceViewMode } from "#/components/sidebar/chat-sidebar";
import { collectCitedDocuments } from "#/lib/documents/cited-documents";
import { collectWebSources } from "#/lib/chat/web-sources";
import {
  collectGeneratedImagesFromMessages,
  countRunningImageToolPartsFromMessages,
  mergeGeneratedImages,
  type GeneratedImageItem,
} from "#/lib/chat/generated-images";
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
import type { ContextSnippetSourceRole } from "#/lib/chat/context-snippet-text";
import { finalizeInterruptedTools } from "#/lib/chat/finalize-interrupted-tools";
import {
  nextFlushableItem,
  pendingBeforeEditing,
  chunkIds,
  type QueuedDraft,
  type QueuedItem,
} from "#/lib/chat/queued-messages";
import {
  computeGenerationActionInfo,
  getMessageRawText,
} from "#/lib/chat/message-text";
import {
  EMPTY_CHAT_TITLE,
  findEmptyNewChat,
  isEmptyNewChat,
  sessionSummaryFromDraft,
  type SessionSummary,
} from "#/lib/session-history";
import {
  persistImageGenSettings,
  persistImageGenerationEnabled,
  persistSelectedModel,
  persistSelectedReasoningEffort,
  readImageGenSettings,
  readImageGenerationEnabled,
  readSelectedModel,
  readSelectedReasoningEffort,
} from "#/lib/chat-preferences";
import {
  modelById,
  resolveReasoningFallback,
} from "#/lib/chat/models";
import { useContextSnippet } from "#/hooks/use-context-snippet";
import { useModels } from "#/hooks/use-models";
import { useQueuedMessages } from "#/hooks/use-queued-messages";
import {
  clearStoredSessionId,
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
      throw redirect({
        to: "/login",
        search: { redirect: "/" },
        viewTransition: true,
      });
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

/**
 * `kind` joins `ChatMessageMeta` in a later task; for now read it straight
 * from the raw metadata object.
 */
function metadataKind(metadata: UIMessage["metadata"]): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

/** Raw text of the most recent user message, for prefill after a failed run. */
function failedUserMessageText(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return getMessageRawText(message);
  }
  return null;
}

function createClientMessageId() {
  return crypto.randomUUID();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
  const modelsState = useModels();
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
  const [activeRuns, setActiveRuns] = useState<ReadonlySet<string>>(new Set());
  const [imageContextActions, setImageContextActions] = useState<ImagePreviewContextActions | null>(null);
  const activeRunsRef = useRef<ReadonlySet<string>>(new Set());
  activeRunsRef.current = activeRuns;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const handleAuthFailure = useCallback(() => {
    void navigate({
      to: "/login",
      search: { redirect: "/" },
      viewTransition: true,
    });
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

  const loadSessionsFirstPage = useCallback(
    async (options?: { silent?: boolean }) => {
      const { silent = false } = options ?? {};
      const activeId = sessionIdRef.current;
      const inProject = viewModeRef.current === "project-workspace";
      const inStandalone = viewModeRef.current === "standalone";
      const projectId = inProject ? activeProjectIdRef.current : null;
      if (!silent) setSessionsLoading(true);
      setSessionsError(null);
      try {
        const page = await listSessions({
          limit: SESSIONS_PAGE_SIZE,
          projectId: projectId ?? undefined,
        });
        // Never show an unread dot on the active session: a background
        // refresh can land before the mark-read POST commits.
        let items = page.items.map((session) =>
          session.sessionId === sessionIdRef.current
            ? { ...session, unread: false }
            : session,
        );
        setNextCursor(page.nextCursor);

        // In chat views: active session must belong to this list. Never invent
        // phantom drafts (that stacked "New chat" when switching project↔all).
        // Skipped on silent refreshes so a poll never switches the session.
        if (!silent && (inProject || inStandalone)) {
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

        if (silent) {
          // In-place merge: fetched page replaces/appends/drops the ids it
          // covers, preserving items beyond the first page still in state.
          setSessions((current) => {
            const fetchedIds = new Set(items.map((s) => s.sessionId));
            const extras = current.filter(
              (s) => !fetchedIds.has(s.sessionId),
            );
            return [...items, ...extras];
          });
        } else {
          setSessions(items);
        }
      } catch (error) {
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        console.error("[sessions] failed to load", error);
        if (!silent) setSessionsError("Could not load conversations");
      } finally {
        if (!silent) setSessionsLoading(false);
      }
    },
    [handleAuthFailure],
  );

  // Sidebar status: which sessions have a running worker, and refresh the list
  // so unread markers appear once a run completes in the background.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const runs = await listActiveRuns();
        if (cancelled) return;
        const next = new Set(runs.map((run) => run.sessionId));
        const changed =
          next.size !== activeRunsRef.current.size ||
          [...next].some((id) => !activeRunsRef.current.has(id));
        setActiveRuns(next);
        if (changed) {
          await loadSessionsFirstPage({ silent: true });
        }
      } catch (error) {
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        // Transient poll failure — keep the last known state.
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadSessionsFirstPage, handleAuthFailure]);

  // Opening a session clears its unread marker (server + local list, so the
  // dot does not reappear after navigating away before the next refetch).
  useEffect(() => {
    if (!sessionId) return;
    setSessions((current) =>
      current.map((s) =>
        s.sessionId === sessionId ? { ...s, unread: false } : s,
      ),
    );
    void markSessionRead(sessionId).catch(() => {});
  }, [sessionId]);

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
          setInitialMessages(
            finalizeInterruptedTools(
              initialMessagesFromMemory(data as never),
            ),
          );
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

  const handleRenameSession = useCallback(
    async (targetSessionId: string, title: string) => {
      try {
        const renamed = await renameSession(targetSessionId, title);
        setSessions((current) =>
          current.map((s) =>
            s.sessionId === targetSessionId ? { ...s, title: renamed.title } : s,
          ),
        );
      } catch (error) {
        if (error instanceof ApiAuthError) {
          handleAuthFailure();
          return;
        }
        throw error;
      }
    },
    [handleAuthFailure],
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
        // Surfaced by the confirm dialog (e.g. "still processing").
        throw error;
      }

      if (
        sessionIdRef.current === targetSessionId &&
        (viewModeRef.current === "standalone" ||
          viewModeRef.current === "project-workspace")
      ) {
        const rest = sessionsRef.current.filter(
          (s) => s.sessionId !== targetSessionId,
        );
        const empty = findEmptyNewChat(rest);
        const replacement = empty ?? rest[0] ?? null;
        if (replacement) {
          setSessionId(replacement.sessionId);
          if (viewModeRef.current === "standalone") {
            persistLastStandaloneSessionId(replacement.sessionId);
          }
        } else {
          const projectId =
            viewModeRef.current === "project-workspace"
              ? activeProjectIdRef.current
              : null;
          try {
            const draft = await getOrCreateEmptyChatSession({ projectId });
            setSessionId(draft.sessionId);
            if (!projectId) persistLastStandaloneSessionId(draft.sessionId);
          } catch (error) {
            console.error("[sessions] draft after delete failed", error);
            // Recover: the next list load will create a fresh draft.
            setSessionId("");
            void loadSessionsFirstPage();
          }
        }
      }

      setActiveRuns((current) => {
        if (!current.has(targetSessionId)) return current;
        const next = new Set(current);
        next.delete(targetSessionId);
        return next;
      });

      // Browser views keep no chat selection; clear a stale deleted id so it
      // does not linger in state/storage (the next list load self-heals).
      if (
        sessionIdRef.current === targetSessionId &&
        viewModeRef.current !== "standalone" &&
        viewModeRef.current !== "project-workspace"
      ) {
        setSessionId("");
        clearStoredSessionId();
      }
    },
    [handleAuthFailure],
  );

  const handleRemoveSession = useCallback((targetSessionId: string) => {
    setSessions((current) =>
      current.filter((s) => s.sessionId !== targetSessionId),
    );
  }, []);

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
    <ImagePreviewProvider actions={imageContextActions}>
      <AppShell
        user={user}
        sessions={sessions}
        activeSessionId={sessionId}
        activeRuns={activeRuns}
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
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onRemoveSession={handleRemoveSession}
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
                models={modelsState.models}
                reasoningEfforts={modelsState.reasoningEfforts}
                modelsStatus={modelsState.status}
                modelsError={modelsState.error}
                modelsRetry={modelsState.retry}
                onStreamSettled={() => {
                  void refreshSessionsQuiet();
                }}
                onAuthFailure={handleAuthFailure}
                onImageContextActions={setImageContextActions}
                onReloadMessages={(messages) => setInitialMessages(messages)}
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
  models,
  reasoningEfforts,
  modelsStatus,
  modelsError,
  modelsRetry,
  onStreamSettled,
  onAuthFailure,
  onImageContextActions,
  onReloadMessages,
}: {
  sessionId: string;
  projectId?: string | null;
  initialMessages: UIMessage[];
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  modelsStatus: "loading" | "success" | "error";
  modelsError: string | null;
  modelsRetry: () => void;
  onStreamSettled: () => void;
  onAuthFailure: () => void;
  onImageContextActions?: (
    actions: ImagePreviewContextActions | null,
  ) => void;
  /** Replaces the loaded conversation (fresh history after a stale dialog). */
  onReloadMessages?: (messages: UIMessage[]) => void;
}) {
  const composerInputRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);
  const [ingestionItems, setIngestionItems] = useState<IngestionItem[]>([]);
  const [sessionDocuments, setSessionDocuments] = useState<SessionDocument[]>(
    [],
  );
  const [sessionImages, setSessionImages] = useState<GeneratedImageMeta[]>([]);
  const [sessionImagesError, setSessionImagesError] = useState(false);
  const [activeContextImages, setActiveContextImages] = useState<
    GeneratedImageMeta[]
  >([]);
  const [removingDocumentId, setRemovingDocumentId] = useState<string | null>(
    null,
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [attachmentErrors, setAttachmentErrors] = useState<AttachmentReject[]>(
    [],
  );
  const [isIngesting, setIsIngesting] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    readSelectedModel(models),
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(() =>
    readImageGenerationEnabled(),
  );
  const [imageGenSettings, setImageGenSettings] = useState<ImageGenSettings>(() =>
    readImageGenSettings(),
  );
  const [capabilities, setCapabilities] = useState<WebCapabilities | null>(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<string | null>(null);
  const [compaction, setCompaction] = useState<{
    phase: "idle" | "start" | "complete" | "error";
  }>({ phase: "idle" });
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(
    null,
  );
  const [contextUsageError, setContextUsageError] = useState(false);
  const [previousRunError, setPreviousRunError] = useState(false);
  /** Latest model/effort for createRequest (avoids stale closures). */
  const selectedModelRef = useRef(selectedModel);
  const selectedReasoningEffortRef = useRef(selectedReasoningEffort);
  const webSearchEnabledRef = useRef(webSearchEnabled);
  const imageGenerationEnabledRef = useRef(imageGenerationEnabled);
  const imageGenSettingsRef = useRef(imageGenSettings);
  selectedModelRef.current = selectedModel;
  selectedReasoningEffortRef.current = selectedReasoningEffort;
  webSearchEnabledRef.current = webSearchEnabled;
  imageGenerationEnabledRef.current = imageGenerationEnabled;
  imageGenSettingsRef.current = imageGenSettings;
  /** Latest chat messages for stable event handlers (see handleChatEvent). */
  const messagesRef = useRef<UIMessage[]>([]);
  /** Latest chat controller for stable event handlers (see onError / stop). */
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  const modelsStatusRef = useRef(modelsStatus);
  modelsStatusRef.current = modelsStatus;
  const reasoningInitializedRef = useRef(false);
  const contextUsageVersionRef = useRef(0);
  /** Deferred composer prefill after a streamed run failure (editor is read-only while streaming). */
  const pendingFailedTextRef = useRef<string | null>(null);
  /** Shared with doc rail so its bottom band matches the textfield dock. */
  const [composerDockH, setComposerDockH] = useState(120);

  const queuedState = useQueuedMessages(sessionId);
  const { items: queuedItems, actions: queueActions } = queuedState;
  const queuedItemsRef = useRef(queuedItems);
  queuedItemsRef.current = queuedItems;
  const [queueHold, setQueueHold] = useState(false);
  const [queueConflictOpen, setQueueConflictOpen] = useState(false);
  const autoFlushBusyRef = useRef(false);
  const autoFlushPreserveRef = useRef(false);
  const submitBypassRef = useRef(false);
  const pendingManualSubmitRef = useRef<{
    input: string;
    attachments: UIAttachment[];
    chatController: ReturnType<typeof useChat>;
    clear: () => void;
  } | null>(null);
  const [editHydration, setEditHydration] = useState<{
    version: number;
    draft: QueuedDraft | null;
  } | null>(null);
  const editHydrationVersionRef = useRef(0);
  const [clearComposerSignal, setClearComposerSignal] = useState<{
    version: number;
  } | null>(null);
  const clearSignalVersionRef = useRef(0);

  useEffect(() => {
    if (queuedItems.length === 0 && queueHold) setQueueHold(false);
  }, [queuedItems.length, queueHold]);

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

  /**
   * Session image history. Refetched on mount, after regenerate/truncate, and
   * retried when the last fetch failed. Version guard drops stale responses
   * (e.g. a fetch kicked off by an action in a previous run).
   */
  const sessionImagesVersionRef = useRef(0);
  const refreshSessionImages = useCallback(async () => {
    const version = ++sessionImagesVersionRef.current;
    try {
      const images = await fetchSessionImages(sessionId);
      if (version !== sessionImagesVersionRef.current) return;
      setSessionImages(images);
      setSessionImagesError(false);
    } catch {
      if (version === sessionImagesVersionRef.current) {
        // Keep the previous list, but flag it so the next relevant event
        // (docs refresh / regenerate / truncate) retries instead of silently
        // serving stale data.
        setSessionImagesError(true);
      }
    }
  }, [sessionId]);

  const sessionDocumentIds = useMemo(
    () => new Set(sessionDocuments.map((doc) => doc.id)),
    [sessionDocuments],
  );

  const handleLinkedDocuments = useCallback((documents: SessionDocument[]) => {
    setSessionDocuments(documents);
  }, []);

  /** Guardrail rejects (size limit…) reported at attach time by the composer. */
  const handleAttachmentRejected = useCallback((rejects: AttachmentReject[]) => {
    setAttachmentErrors((current) => [...current, ...rejects]);
  }, []);

  const handleDismissAttachmentError = useCallback((id: string) => {
    setAttachmentErrors((current) =>
      current.filter((item) => item.id !== id),
    );
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

  /** Writes failed-run text into the composer editor (same selector as focusComposer). */
  const setComposerInputText = useCallback((text: string) => {
    let attempts = 0;

    const trySet = () => {
      const editor = composerInputRef.current?.querySelector<HTMLElement>(
        "[data-anvia-composer-editor]",
      );
      if (editor) {
        editor.textContent = text;
        editor.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text,
          }),
        );
        return;
      }
      if (attempts++ < 20) {
        requestAnimationFrame(trySet);
      }
    };

    trySet();
  }, []);

  /** Fetch context usage once; shared by the polling effect and message_end. */
  const refreshContextUsage = useCallback(async () => {
    if (modelsStatusRef.current !== "success") return;
    const version = ++contextUsageVersionRef.current;
    try {
      const usage = await fetchContextUsage({
        sessionId,
        model: selectedModelRef.current,
        reasoningEffort: selectedReasoningEffortRef.current,
      });
      if (version !== contextUsageVersionRef.current) return;
      setContextUsage(usage);
      setContextUsageError(false);
    } catch {
      if (version === contextUsageVersionRef.current) {
        setContextUsageError(true);
      }
    }
  }, [sessionId]);

  const handleChatEvent = useCallback(
    (event: unknown) => {
      if (!event || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      if (record.type === "compaction") {
        const phase =
          record.phase === "start"
            ? "start"
            : record.phase === "complete"
              ? "complete"
              : record.phase === "error"
                ? "error"
                : "idle";
        setCompaction({ phase });
        return;
      }
      if (record.type === "message_end") {
        void refreshContextUsage();
        return;
      }
      if (record.type === "queued_message_applied") {
        const clientMessageId =
          typeof record.clientMessageId === "string"
            ? record.clientMessageId
            : null;
        if (clientMessageId) {
          const item = queuedItemsRef.current.find(
            (entry) => entry.id === clientMessageId,
          );
          if (item) {
            chatRef.current?.setMessages((current) => {
              const exists = current.some(
                (message) =>
                  message.role === "user" &&
                  readChatMessageMeta(message.metadata).clientMessageId ===
                    clientMessageId,
              );
              if (exists) return current;
              const parts: UIMessage["parts"] = [
                ...item.attachments.map((attachment) => ({
                  id: crypto.randomUUID(),
                  type: "attachment" as const,
                  attachment,
                })),
              ];
              if (item.text.trim().length > 0) {
                parts.push({
                  id: crypto.randomUUID(),
                  type: "text",
                  text: item.text,
                });
              }
              return [
                ...current,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts,
                  metadata: withChatMessageMeta(undefined, {
                    sessionId,
                    clientMessageId,
                    createdAt: new Date().toISOString(),
                    documentIds: item.documentIds,
                    ...(item.contextSnippet
                      ? { contextSnippet: item.contextSnippet }
                      : {}),
                  }),
                },
              ];
            });
            queueActions.applyAck(clientMessageId);
            if (item.attachments.length > 0) void refreshSessionImages();
          }
        }
        return;
      }
      if (record.type === "error") {
        const errorText =
          record.error instanceof Error
            ? record.error.message
            : typeof record.error === "string"
              ? record.error
              : "The agent run failed";
        setComposerError(`Run failed: ${errorText}`);
        setQueueHold(true);
        const failedText = failedUserMessageText(messagesRef.current);
        if (failedText !== null) {
          // The editor is read-only while streaming; apply once the stream ends.
          pendingFailedTextRef.current = failedText;
        }
      }
    },
    [queueActions, refreshContextUsage, refreshSessionImages],
  );

  const chat = useChat({
    transport: chatTransport,
    initialMessages,
        // Resume is driven explicitly by the run-status join effect: a stale
        // snapshot must never replace the fresh history load (which carries
        // compaction dividers / final messages).
        resume: { key: sessionId, storage: "sessionStorage", auto: false },
    createRequest: ({ coreMessages, uiMessages, resume }) => {
      const last = uiMessages.at(-1);
      const documentIds = documentIdsFromMetadata(last?.metadata);

      return {
        messages: coreMessages,
        stream: true as const,
        sessionId,
        documentIds,
        model: selectedModelRef.current,
        reasoningEffort: selectedReasoningEffortRef.current,
        webSearchEnabled: webSearchEnabledRef.current,
        imageGenerationEnabled: imageGenerationEnabledRef.current,
        imageGenSettings: imageGenSettingsRef.current,
        ...(resume ? { resume } : {}),
      };
    },
    humanInput: {
      // Custom decideApproval: defaultDecideApproval fetches without
      // credentials, which 401s cross-origin (platform :3000 → API :3001).
      // The api.ts helper sends credentials: "include", maps 401 →
      // ApiAuthError, and carries optional grantScope/overrideArgs.
      decideApproval: async (decision) => {
        await decideApproval(decision);
        // Server replies { ok: true } — not a ToolApproval. The stream event
        // carries the resolved approval state, so nothing to return here.
        return undefined;
      },
    },
    onEvent: handleChatEvent,
    onError: (error) => {
      if (error instanceof ApiAuthError) {
        onAuthFailure();
        return;
      }
      if (error instanceof EventStreamHttpError && error.response.status === 409) {
        // Another tab already holds the active-run lock for this session.
        let runActive = true;
        try {
          const parsed: unknown = JSON.parse(error.body);
          runActive =
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { code?: unknown }).code === "RUN_ACTIVE";
        } catch {
          // Unparseable body — fall back to the status check alone.
        }
        if (runActive) {
          setComposerError(
            "This session is already being processed in another tab.",
          );
          chatRef.current?.setMessages((current) => {
            const last = current.at(-1);
            if (!last || last.role !== "user") return current;
            return current.slice(0, -1);
          });
        }
      }
    },
  });

  chatRef.current = chat;

  // Keep the latest messages readable from stable event handlers.
  useEffect(() => {
    messagesRef.current = chat.messages;
  }, [chat.messages]);

  const resumeChatRef = useRef(chat.resume);
  resumeChatRef.current = chat.resume;

  /**
   * Stop button: ask the worker to end the run (including any pending
   * approval / clarification waiters), finalize in-flight tool cards so they
   * do not stay forever-"Working", then reset the local chat controller so
   * status returns to idle and human-input panels close. `chat.stop()` alone
   * aborts the fetch but leaves pending approvals/clarifications open and
   * leaves tool parts at `input-available`. Composer.Stop still calls
   * `chat.stop()` after this — harmless double abort.
   */
  const handleStopRun = useCallback(() => {
    const current = chatRef.current;
    if (!current) return;
    const streamId = current.streamId;
    if (streamId) {
      void stopChatRun(streamId).catch(() => {
        // best-effort: local reset still stops the client stream
      });
    }
    current.reset(finalizeInterruptedTools(current.messages));
    setQueueHold(true);
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    persistSelectedModel(model);
  }, []);

  const handleReasoningChange = useCallback((effort: string | null) => {
    setSelectedReasoningEffort(effort);
    persistSelectedReasoningEffort(effort);
  }, []);

  /**
   * Active image context — images pinned by the user as chat context for this
   * session. Refetched on mount/session change; toggled via the pin button on
   * thumbnails (a confirmation modal gates non-vision models).
   */
  const activeContextVersionRef = useRef(0);
  const refreshActiveContext = useCallback(async () => {
    const version = ++activeContextVersionRef.current;
    try {
      const images = await fetchSessionImageContexts(sessionId);
      if (version !== activeContextVersionRef.current) return;
      setActiveContextImages(images);
    } catch {
      // keep previous list on failure
    }
  }, [sessionId]);

  const contextSnippetState = useContextSnippet(sessionId);

  const handleAddContext = useCallback(
    async (text: string, sourceRole: ContextSnippetSourceRole) => {
      return contextSnippetState.setSnippet(text, sourceRole);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snippet state is internal to the hook
    [contextSnippetState.setSnippet],
  );

  // Pinning works with any model: vision models receive the images as image
  // input, text-only models get them via the view_image helper tool.
  const handleToggleImageContext = useCallback(
    async (image: GeneratedImageItem) => {
      const isPinned = activeContextImages.some((item) => item.id === image.id);
      if (isPinned) {
        try {
          await removeSessionImageContext({ sessionId, imageId: image.id });
          void refreshActiveContext();
        } catch (error) {
          setComposerError(
            error instanceof Error
              ? error.message
              : "Could not update image context",
          );
        }
        return;
      }

      try {
        await addSessionImageContext({ sessionId, imageId: image.id });
        void refreshActiveContext();
      } catch (error) {
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not add image context",
        );
      }
    },
    [activeContextImages, sessionId, refreshActiveContext],
  );

  const handleImageGenerationToggle = useCallback((enabled: boolean) => {
    setImageGenerationEnabled(enabled);
    persistImageGenerationEnabled(enabled);
  }, []);

  // Register the context actions with the ImagePreviewProvider (rendered one
  // level up) so the viewer's "Add to context" button can toggle pinning.
  const previewIsPinned = useCallback(
    (image: GeneratedImageItem) =>
      activeContextImages.some((item) => item.id === image.id),
    [activeContextImages],
  );
  useEffect(() => {
    onImageContextActions?.({
      toggle: handleToggleImageContext,
      isPinned: previewIsPinned,
    });
    return () => onImageContextActions?.(null);
  }, [onImageContextActions, handleToggleImageContext, previewIsPinned]);

  const handleImageGenSettingsChange = useCallback(
    (settings: ImageGenSettings) => {
      setImageGenSettings(settings);
      persistImageGenSettings(settings);
    },
    [],
  );

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
      void markSessionRead(sessionId).catch(() => {});
      // A failed run defers its composer prefill until the editor is editable.
      if (pendingFailedTextRef.current !== null) {
        setComposerInputText(pendingFailedTextRef.current);
        pendingFailedTextRef.current = null;
      }
      focusComposer();
    }
    wasStreamingRef.current = chat.status === "streaming";
  }, [
    chat.setMessages,
    chat.status,
    focusComposer,
    onStreamSettled,
    sessionDocuments,
    setComposerInputText,
  ]);

  useEffect(() => {
    focusComposer();
  }, [focusComposer]);

  useEffect(() => {
    setSessionDocuments([]);
    setSessionImages([]);
    setSessionImagesError(false);
    setActiveContextImages([]);
    setIngestionItems([]);
    setComposerError(null);
    setAttachmentErrors([]);
    setIsIngesting(false);
    setContextUsage(null);
    setContextUsageError(false);
    setCompaction({ phase: "idle" });
    setPreviousRunError(false);
    void refreshSessionDocuments();
    void refreshSessionImages();
    void refreshActiveContext();
  }, [
    refreshSessionDocuments,
    refreshSessionImages,
    refreshActiveContext,
  ]);

  // Capabilities are global (not per-session) — best-effort fetch; the
  // module-wide promise cache in lib/api makes this cheap on remounts.
  useEffect(() => {
    void fetchChatCapabilities()
      .then(setCapabilities)
      .catch(() => {
        // capabilities stay null; toggles render as unavailable
      });
  }, []);

  useEffect(() => {
    setEditingMessageId(null);
  }, [sessionId]);

  // Reconcile the selected model once the catalog arrives:
  // stored preference > first active model > default. Always apply the
  // storage-aware read — at mount the catalog is still empty (loading), so
  // without this the stored preference would never be restored.
  useEffect(() => {
    if (modelsStatus !== "success") return;
    const next = readSelectedModel(models);
    if (next !== selectedModelRef.current) {
      setSelectedModel(next);
      persistSelectedModel(next);
    }
  }, [models, modelsStatus]);

  const activeModel = useMemo(
    () => modelById(models, selectedModel),
    [models, selectedModel],
  );

  // Init the reasoning effort from storage on first catalog arrival; on model
  // change, resolve a supported fallback for the new model and persist both.
  useEffect(() => {
    if (!activeModel) return;
    const base = reasoningInitializedRef.current
      ? selectedReasoningEffortRef.current
      : readSelectedReasoningEffort(activeModel.reasoningEfforts);
    reasoningInitializedRef.current = true;
    const next = resolveReasoningFallback(
      base,
      activeModel.reasoningEfforts,
      reasoningEfforts,
    );
    if (next !== selectedReasoningEffortRef.current) {
      setSelectedReasoningEffort(next);
      persistSelectedReasoningEffort(next);
    }
  }, [activeModel, reasoningEfforts]);

  // Poll context usage every 30s while the catalog is available.
  useEffect(() => {
    if (modelsStatus !== "success") return;
    void refreshContextUsage();
    const timer = window.setInterval(() => {
      void refreshContextUsage();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [modelsStatus, refreshContextUsage]);

  // Refetch context usage whenever the selected model / effort changes so the
  // ring and popover always reflect the ACTIVE model's window and ratio.
  useEffect(() => {
    if (modelsStatus !== "success") return;
    void refreshContextUsage();
  }, [selectedModel, selectedReasoningEffort, modelsStatus, refreshContextUsage]);

  // Rejoin a still-running run on load (closed-tab recovery) and surface a
  // banner for a run that failed server-side. "missing" behaves as idle.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await fetchRunStatus(sessionId);
        if (cancelled) return;
        if (status.status === "error") {
          setPreviousRunError(true);
        }
        const key = `anvia:chat-resume:${sessionId}`;
        if (status.status === "running" && status.streamId) {
          const stored = sessionStorage.getItem(key);
          if (!stored) {
            sessionStorage.setItem(
              key,
              JSON.stringify({
                version: 1,
                streamId: status.streamId,
                lastEventId: 0,
                messages: messagesRef.current,
              }),
            );
          }
          // Join regardless of whether a state snapshot already exists
          // (auto-resume is off; this is the only rejoin path).
          void resumeChatRef.current();
        } else {
          // No active run: drop any leftover resume snapshot so it can never
          // replace the fresh history load (e.g. compaction dividers) on a
          // later mount.
          sessionStorage.removeItem(key);
        }
      } catch {
        // ignore — resume state (if any) still handles rejoin
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- join once per sessionId
  }, [sessionId]);

  // Prefill the composer from a persisted failed [user, assistant error] tail.
  useEffect(() => {
    if (modelsStatus !== "success" || initialMessages.length < 2) return;
    const last = initialMessages.at(-1);
    const secondLast = initialMessages.at(-2);
    if (
      !last ||
      last.role !== "assistant" ||
      !secondLast ||
      secondLast.role !== "user"
    ) {
      return;
    }
    if (metadataKind(last.metadata) !== "error") return;
    setComposerInputText(getMessageRawText(secondLast));
  }, [initialMessages, modelsStatus, setComposerInputText]);

  // ─── Stale-session guard (freshness check before send) ───────────────────
  // The server memory is the source of truth; another window/device may have
  // appended messages. Compare persisted counts: stale ⟺ server has MORE
  // messages than this view knows. Fail-open when the fetch fails.
  const [staleDialog, setStaleDialog] = useState<{
    kind: "send" | "resubmit";
  } | null>(null);
  /**
   * Latest send body, kept in a ref so handlers can re-invoke it without
   * stale closures (same pattern as chatRef/resumeChatRef).
   */
  const submitComposerRef = useRef<
    (
      input: string,
      attachments: UIAttachment[],
      chat: ReturnType<typeof useChat>,
      clear: () => void,
    ) => Promise<void>
  >(async () => {});

  /**
   * Shared doc-upload step for manual and queued sends: ingests every
   * non-image attachment, returns their session document ids. Throws on
   * failure (composerError already set by the caller).
   */
  const uploadComposerDocuments = useCallback(
    async (attachments: UIAttachment[]): Promise<string[]> => {
      const documentAttachments = attachments.filter(
        (attachment) => !isImageAttachmentLike(attachment),
      );
      const documentIds: string[] = [];
      if (documentAttachments.length === 0) return documentIds;

      setIsIngesting(true);
      setIngestionItems([]);
      try {
        for (const attachment of documentAttachments) {
          const file = await resolveAttachmentFile(attachment);
          if (file.size === 0) {
            throw new Error(`File is empty: ${file.name}`);
          }
          const itemId = attachment.id || crypto.randomUUID();
          setIngestionItems((current) => [
            ...current,
            { id: itemId, filename: file.name, status: "uploading" },
          ]);
          const uploaded = await uploadDocument({ sessionId, file, projectId });
          const ready = await waitForDocumentReady({
            sessionId,
            documentId: uploaded.id,
            onStatus: (status) => {
              setIngestionItems((current) =>
                current.map((item) =>
                  item.id === itemId ? { ...item, status: status.status } : item,
                ),
              );
            },
          });
          documentIds.push(ready.id);
        }
        await refreshSessionDocuments();
        // Retry a failed image-history fetch alongside the docs refresh
        // so the rail doesn't silently serve stale data.
        if (sessionImagesError) void refreshSessionImages();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Document processing failed";
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
        throw error;
      } finally {
        setIsIngesting(false);
      }
      return documentIds;
    },
    [projectId, refreshSessionDocuments, sessionId, sessionImagesError],
  );

  /**
   * Queue the composer draft (send-while-streaming / hold): pre-uploads
   * documents at queue time, snapshots single-use context (snippet + pins)
   * into the item, and clears the composer via the versioned clear signal.
   */
  const queueComposerDraft = useCallback(
    async ({
      input,
      attachments,
    }: {
      input: string;
      attachments: UIAttachment[];
    }): Promise<void> => {
      const trimmed = input.trim();
      if (!trimmed && attachments.length === 0) return;

      let documentIds: string[] = [];
      try {
        documentIds = await uploadComposerDocuments(attachments);
      } catch {
        return; // upload failed — composerError already set, nothing queued
      }

      const imageAttachments: UIAttachment[] = [];
      for (const attachment of attachments) {
        if (!isImageAttachmentLike(attachment)) continue;
        if (attachment.url?.startsWith("blob:")) {
          try {
            const response = await fetch(attachment.url);
            const blob = await response.blob();
            imageAttachments.push({
              ...attachment,
              url: undefined,
              data: await blobToDataUrl(blob),
            });
          } catch {
            setComposerError("Could not read image attachment");
            return;
          }
        } else {
          imageAttachments.push(attachment);
        }
      }

      const snippet = contextSnippetState.snippet;
      const pinnedImageIds = activeContextImages.map((image) => image.id);

      queueActions.queueItem({
        text: trimmed,
        attachments: imageAttachments,
        documentIds,
        contextSnippet: snippet
          ? { text: snippet.text, sourceRole: snippet.sourceRole }
          : null,
        pinnedImageIds,
      });

      setClearComposerSignal({
        version: ++clearSignalVersionRef.current,
      });
      // Single-use context moved into the item: clear chip (server row) + pins.
      if (snippet) void contextSnippetState.remove().catch(() => {});
      for (const image of activeContextImages) {
        void removeSessionImageContext({ sessionId, imageId: image.id }).catch(
          () => {},
        );
      }
      if (pinnedImageIds.length > 0) void refreshActiveContext();
      void refreshSessionDocuments();
    },
    [
      activeContextImages,
      contextSnippetState,
      queueActions,
      refreshActiveContext,
      refreshSessionDocuments,
      sessionId,
      uploadComposerDocuments,
    ],
  );

  /**
   * Recall a queued item for editing: mark it editing, hydrate the composer
   * with its draft, and restore its single-use context (snippet + pins).
   */
  const handleQueueRecall = useCallback(
    (id: string) => {
      const item = queuedItemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "pending") return;
      queueActions.startEdit(id);
      setEditHydration({
        version: ++editHydrationVersionRef.current,
        draft: {
          text: item.text,
          attachments: item.attachments,
          documentIds: item.documentIds,
          contextSnippet: item.contextSnippet,
          pinnedImageIds: item.pinnedImageIds,
        },
      });
      contextSnippetState.setLocal(
        item.contextSnippet
          ? {
              id: `queue-${item.id}`,
              text: item.contextSnippet.text,
              sourceRole: item.contextSnippet.sourceRole,
              createdAt: new Date().toISOString(),
            }
          : null,
      );
      for (const imageId of item.pinnedImageIds) {
        void addSessionImageContext({ sessionId, imageId }).catch(() => {});
      }
      if (item.pinnedImageIds.length > 0) void refreshActiveContext();
      focusComposer();
    },
    [
      addSessionImageContext,
      contextSnippetState,
      focusComposer,
      queueActions,
      refreshActiveContext,
      sessionId,
    ],
  );

  /** Commit the composer contents back into the editing queue item. */
  const handleSubmitQueueEdit = useCallback(
    async (input: string, attachments: UIAttachment[]) => {
      const editing = queuedItemsRef.current.find(
        (entry) => entry.status === "editing",
      );
      if (!editing) return;
      const trimmed = input.trim();
      if (!trimmed && attachments.length === 0) return;

      let documentIds = editing.documentIds;
      const docAttachments = attachments.filter(
        (attachment) => !isImageAttachmentLike(attachment),
      );
      if (docAttachments.length > 0) {
        try {
          const uploaded = await uploadComposerDocuments(docAttachments);
          documentIds = [...editing.documentIds, ...uploaded];
        } catch {
          return;
        }
      }

      const imageAttachments: UIAttachment[] = [];
      for (const attachment of attachments) {
        if (!isImageAttachmentLike(attachment)) continue;
        if (attachment.url?.startsWith("blob:")) {
          try {
            const response = await fetch(attachment.url);
            const blob = await response.blob();
            imageAttachments.push({
              ...attachment,
              url: undefined,
              data: await blobToDataUrl(blob),
            });
          } catch {
            setComposerError("Could not read image attachment");
            return;
          }
        } else {
          imageAttachments.push(attachment);
        }
      }

      const snippet = contextSnippetState.snippet;
      const pinnedImageIds = activeContextImages.map((image) => image.id);

      queueActions.submitEdit(editing.id, {
        text: trimmed,
        attachments: imageAttachments,
        documentIds,
        contextSnippet: snippet
          ? { text: snippet.text, sourceRole: snippet.sourceRole }
          : null,
        pinnedImageIds,
      });

      setEditHydration({ version: ++editHydrationVersionRef.current, draft: null });
      setClearComposerSignal({ version: ++clearSignalVersionRef.current });
      if (snippet) void contextSnippetState.remove().catch(() => {});
      if (pinnedImageIds.length > 0) void refreshActiveContext();
    },
    [
      activeContextImages,
      contextSnippetState,
      queueActions,
      refreshActiveContext,
      uploadComposerDocuments,
    ],
  );

  /** Abort a queue edit: back to pending, composer cleared, context restored. */
  const handleQueueCancelEdit = useCallback(
    (id: string) => {
      const item = queuedItemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "editing") return;
      queueActions.cancelEdit(id);
      setEditHydration({ version: ++editHydrationVersionRef.current, draft: null });
      setClearComposerSignal({ version: ++clearSignalVersionRef.current });
      contextSnippetState.setLocal(null);
      for (const imageId of item.pinnedImageIds) {
        void removeSessionImageContext({ sessionId, imageId }).catch(() => {});
      }
      if (item.pinnedImageIds.length > 0) void refreshActiveContext();
    },
    [contextSnippetState, queueActions, refreshActiveContext, sessionId],
  );

  /**
   * Build the steer payload for a queued item: record local images in the
   * session gallery, then serialize image attachments + pinned images as
   * base64 attachment data for the active run.
   */
  const buildSteerPayload = useCallback(
    async (item: QueuedItem): Promise<SteerMessageInput> => {
      const steerAttachments: { mediaType: string; data: string }[] = [];
      for (const attachment of item.attachments) {
        if (attachment.type !== "image") continue;
        try {
          // Record the image in the session gallery.
          const file = await resolveAttachmentFile(attachment);
          const dims = await imageDimensionsFromFile(file);
          await uploadSessionImage({
            sessionId,
            file,
            width: dims.width,
            height: dims.height,
            projectId,
          });
        } catch {
          setComposerError("Could not upload queued image");
          throw new Error("Could not upload queued image");
        }
        const raw = attachment.data ?? "";
        const base64 = raw.startsWith("data:")
          ? (raw.split(",", 2)[1] ?? "")
          : raw;
        if (base64.length === 0) continue;
        steerAttachments.push({
          mediaType: attachment.mediaType ?? "image/png",
          data: base64,
        });
      }
      for (const imageId of item.pinnedImageIds) {
        try {
          const { blob, mediaType } = await fetchImageBytes(imageId);
          const dataUrl = await blobToDataUrl(blob);
          steerAttachments.push({
            mediaType,
            data: dataUrl.split(",", 2)[1] ?? "",
          });
        } catch {
          // skip images that fail to load
        }
      }
      return {
        clientMessageId: item.id,
        text: item.text,
        ...(steerAttachments.length > 0 ? { attachments: steerAttachments } : {}),
        ...(item.contextSnippet ? { contextSnippet: item.contextSnippet } : {}),
      };
    },
    [projectId, sessionId],
  );

  /** Send every pending item into the session's ACTIVE run via steer. */
  const handleQueueSendNow = useCallback(async () => {
    if (autoFlushBusyRef.current) return;
    const toSend = pendingBeforeEditing(queuedItemsRef.current);
    if (toSend.length === 0) return;
    queueActions.markInflight(new Set(toSend.map((item) => item.id)));
    try {
      const payloads: SteerMessageInput[] = [];
      for (const item of toSend) {
        payloads.push(await buildSteerPayload(item));
      }
      await steerChatMessages({ sessionId, messages: payloads });
      setQueueHold(false);
    } catch (error) {
      queueActions.revertInflight();
      if (isSteerNoActiveRunError(error)) {
        // The run ended between render and post — the auto-flush effect
        // sends it as a new run once idle.
        setQueueHold(false);
      } else {
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not send queued messages",
        );
      }
    }
  }, [buildSteerPayload, queueActions, sessionId]);

  /**
   * Shared send step for manual and queued sends: uploads local image
   * attachments, attaches pinned context, builds the bubble attachments and
   * metadata, and sends the message through the live chat controller.
   */
  const sendDraft = useCallback(
    async (input: {
      text: string;
      attachments: UIAttachment[];
      documentIds: string[];
      pinnedImageIds: string[];
      preserveComposer?: boolean;
    }): Promise<void> => {
      // Local images attach to the message like pinned context (uploaded
      // to the session image store + auto-pinned so the model sees them).
      const uploadedImageAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        data?: string;
        text?: string;
      }> = [];
      for (const attachment of input.attachments.filter((a) =>
        isImageAttachmentLike(a),
      )) {
        const file = await resolveAttachmentFile(attachment);
        if (file.size === 0) {
          throw new Error(`File is empty: ${file.name}`);
        }
        const dims = await imageDimensionsFromFile(file);
        const meta = await uploadSessionImage({
          sessionId,
          file,
          width: dims.width,
          height: dims.height,
          projectId,
        });
        // Auto-pin so the worker injects it as image input (vision)
        // or exposes it via view_image (text-only models).
        await addSessionImageContext({ sessionId, imageId: meta.id });
        const { blob, mediaType } = await fetchImageBytes(meta.id);
        uploadedImageAttachments.push({
          id: `ctx-${meta.id}`,
          type: "image",
          name: meta.prompt || "Uploaded image",
          mediaType,
          data: await blobToDataUrl(blob),
          text: meta.prompt || "Uploaded image",
        });
      }

      // Documents ingest after images — the old manual-submit order, so a
      // failed image upload never leaves freshly ingested docs orphaned.
      // Queued-path compatibility (Task 12): queued items carry image-only
      // attachments with their documentIds pre-uploaded at queue time, so
      // the non-image filter finds nothing here and the prelinked ids pass
      // through untouched.
      const documentIds = [
        ...input.documentIds,
        ...(await uploadComposerDocuments(input.attachments)),
      ];

      // Active image context: attach pinned images to the user bubble so
      // they are visible in the sent message (the worker injects them as
      // image input to the model).
      const contextAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        url?: string;
        data?: string;
        text?: string;
      }> = [];
      for (const imageId of input.pinnedImageIds) {
        try {
          const { blob, mediaType } = await fetchImageBytes(imageId);
          contextAttachments.push({
            id: `ctx-${imageId}`,
            type: "image",
            name: "Image context",
            mediaType,
            data: await blobToDataUrl(blob),
            text: "Image context",
          });
        } catch {
          // skip images that fail to load — the context still works
        }
      }

      const attachedDocuments = input.attachments.map((attachment) => {
        const name = attachment.name ?? "Document";
        return attachment.mediaType
          ? { name, mediaType: attachment.mediaType }
          : { name };
      });

      // Bubble stubs for document attachments only. Uploaded images are
      // attached via uploadedImageAttachments; a bare type:"file" stub with
      // an image mediaType would trip @anvia/core's image-attachment
      // conversion, which requires url/data.
      const documentBubbleAttachments = input.attachments
        .filter((attachment) => !isImageAttachmentLike(attachment))
        .map((attachment) => {
          const name = attachment.name ?? "Document";
          return {
            id: crypto.randomUUID(),
            type: (name === "Document"
              ? "document"
              : "file") as UIAttachment["type"],
            name,
            mediaType: attachment.mediaType,
            text: name,
          };
        });

      const contextSnippet = contextSnippetState.snippet;

      const sendPromise = chatRef.current!.sendMessage({
        text: input.text,
        metadata: withChatMessageMeta(undefined, {
          sessionId,
          documentIds,
          attachedDocuments,
          createdAt: new Date().toISOString(),
          clientMessageId: createClientMessageId(),
          ...(contextSnippet
            ? {
                contextSnippet: {
                  text: contextSnippet.text,
                  sourceRole: contextSnippet.sourceRole,
                },
              }
            : {}),
        }),
        attachments: [
          ...documentBubbleAttachments,
          ...uploadedImageAttachments,
          ...contextAttachments,
        ],
      });

      // Text context is single-use: drop the composer chip the moment the
      // optimistic user bubble exists. Waiting for the stream made the
      // chip linger on the field after Send. The server still clears its
      // own row after the run reads it.
      if (contextSnippet) {
        contextSnippetState.reset();
      }
      await sendPromise;

      if (!input.preserveComposer) {
        // The route clears via the `clear` callback for manual sends; nothing
        // to do here — sendDraft is called by submitComposerRef which clears.
      }
      if (input.pinnedImageIds.length > 0) {
        await refreshActiveContext();
      }
      if (uploadedImageAttachments.length > 0) {
        // Locally uploaded images now live in the session image store —
        // refresh the rail so they appear alongside generated images.
        void refreshSessionImages();
      }
    },
    [
      addSessionImageContext,
      contextSnippetState,
      projectId,
      refreshActiveContext,
      refreshSessionImages,
      sessionId,
      uploadComposerDocuments,
    ],
  );

  /**
   * Auto-flush: when the chat is idle and items wait, send the next one as
   * a fresh run (queue-held items wait for "Send now" / hold release).
   */
  useEffect(() => {
    if (chat.status !== "idle") return;
    if (!initialMessages) return;
    if (queueHold || autoFlushBusyRef.current) return;
    if (nextFlushableItem(queuedItemsRef.current) === null) return;

    autoFlushBusyRef.current = true;
    void (async () => {
      try {
        // Purge items already applied server-side (missed acks across reloads).
        // Applied ids accumulate into ONE set so every chunk's dedupe is
        // applied at once — filtering per-chunk would read a stale snapshot.
        const ids = queuedItemsRef.current.map((item) => item.id);
        const applied = new Set<string>();
        for (const chunk of chunkIds(ids, 50)) {
          try {
            const { appliedIds } = await syncQueuedMessageIds({
              sessionId,
              ids: chunk,
            });
            for (const id of appliedIds) applied.add(id);
          } catch {
            // best-effort dedupe — a duplicate would only re-ask the agent
          }
        }
        let remaining = queuedItemsRef.current;
        if (applied.size > 0) {
          remaining = remaining.filter((item) => !applied.has(item.id));
          queueActions.replaceAll(remaining);
        }
        const candidate = nextFlushableItem(remaining);
        if (!candidate) return;

        const item = candidate.item;
        if (item.contextSnippet) {
          const ok = await contextSnippetState.setSnippet(
            item.contextSnippet.text,
            item.contextSnippet.sourceRole,
          );
          if (!ok) return;
        }
        for (const imageId of item.pinnedImageIds) {
          await addSessionImageContext({ sessionId, imageId }).catch(() => {});
        }

        autoFlushPreserveRef.current = true;
        try {
          await sendDraft({
            text: item.text,
            attachments: item.attachments,
            documentIds: item.documentIds,
            pinnedImageIds: item.pinnedImageIds,
            preserveComposer: true,
          });
        } finally {
          autoFlushPreserveRef.current = false;
        }
        queueActions.removeItem(item.id);
      } finally {
        autoFlushBusyRef.current = false;
      }
    })();
  }, [
    chat.status,
    contextSnippetState,
    initialMessages,
    queueActions,
    queueHold,
    queuedItems,
    sendDraft,
    sessionId,
  ]);

  const isSessionStale = useCallback(async (): Promise<boolean> => {
    try {
      const state = await fetchSessionState(sessionId);
      const localCount = messagesRef.current.filter(
        (message) => message.role === "user" || message.role === "assistant",
      ).length;
      return state.messageCount > localCount;
    } catch {
      // Fail-open: an unreachable server must never block sending.
      return false;
    }
  }, [sessionId]);

  /** Reload the conversation from server truth (used by the stale dialog). */
  const reloadChatFromServer = useCallback(async () => {
    try {
      const data = await loadChatMessages(sessionId);
      const fresh = finalizeInterruptedTools(
        initialMessagesFromMemory(data as never),
      );
      onReloadMessages?.(fresh);
      chatRef.current?.setMessages(fresh);
    } catch {
      // keep the current view on failure
    }
  }, [sessionId, onReloadMessages]);

  const handleStaleReload = useCallback(() => {
    setStaleDialog(null);
    setEditingMessageId(null);
    setEditContextImages([]);
    void reloadChatFromServer();
  }, [reloadChatFromServer]);

  /**
   * Shared path for revert (same text) and edit (new text):
   * truncate memory to exclude the target user message, drop later UI messages,
   * then send a fresh user turn so the agent appends a single clean prompt.
   *
   * Reads chat through `chatRef` so the callback identity is stable (the
   * useChat result object is recreated every render) — memoized message rows
   * depend on the stability of onSubmitEdit/onRevert.
   */
  const [editContextImages, setEditContextImages] = useState<GeneratedImageItem[]>(
    [],
  );

  const resubmitFromUserMessage = useCallback(
    async (message: UIMessage, text: string) => {
      const currentChat = chatRef.current;
      if (!currentChat) {
        throw new Error("Chat is not ready");
      }
      if (currentChat.status === "streaming") {
        throw new Error("Wait for the current reply to finish");
      }

      const index = currentChat.messages.findIndex(
        (item) => item.id === message.id,
      );
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

      // Freshness guard: resubmitting from a stale view would truncate the
      // newer messages added by another window/device — block until reload.
      if (await isSessionStale()) {
        setStaleDialog({ kind: "resubmit" });
        return;
      }

      await truncateSessionMemory({
        sessionId,
        mode: "exclude",
        memoryPosition: meta.memoryPosition,
        clientMessageId: meta.clientMessageId,
      });

      // The dropped run's tool parts leave chat.messages, so live image
      // collection shrinks — resync history to server truth (fire-and-forget).
      void refreshSessionImages();

      currentChat.setMessages(currentChat.messages.slice(0, index));
      setEditingMessageId(null);

      // Attach the context images managed in the edit bubble (view/add/remove)
      // to the resubmitted message, like the normal send flow does.
      const editAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        data?: string;
        text?: string;
      }> = [];
      for (const image of editContextImages) {
        try {
          const { blob, mediaType } = await fetchImageBytes(image.id);
          editAttachments.push({
            id: `ctx-${image.id}`,
            type: "image",
            name: image.prompt || "Image context",
            mediaType,
            data: await blobToDataUrl(blob),
            text: image.prompt || "Image context",
          });
        } catch {
          // skip images that fail to load
        }
      }
      setEditContextImages([]);

      await currentChat.sendMessage({
        text: trimmed,
        metadata: withChatMessageMeta(undefined, {
          sessionId,
          documentIds: meta.documentIds ?? [],
          createdAt: new Date().toISOString(),
          clientMessageId: createClientMessageId(),
        }),
        attachments: editAttachments,
      });
    },
    [sessionId, refreshSessionImages, editContextImages, isSessionStale],
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

  // Stable callbacks so memoized ChatMessageRow rows skip re-renders on
  // unrelated state changes (e.g. model switches).
  const generationInfoMap = useMemo(
    () => computeGenerationActionInfo(chat.messages),
    [chat.messages],
  );
  const citedDocuments = useMemo(
    () => collectCitedDocuments(chat.messages),
    [chat.messages],
  );

  const webSources = useMemo(
    () => collectWebSources(chat.messages),
    [chat.messages],
  );

  const liveGeneratedImages = useMemo(
    () => collectGeneratedImagesFromMessages(chat.messages),
    [chat.messages],
  );

  const runningImageParts = useMemo(
    () => countRunningImageToolPartsFromMessages(chat.messages),
    [chat.messages],
  );

  const generatedImages = useMemo(
    () => mergeGeneratedImages(liveGeneratedImages, sessionImages),
    [liveGeneratedImages, sessionImages],
  );

  /**
   * Resolve the context images attached to a user message so the edit bubble
   * can show / manage them. Live messages carry the id as `ctx-<imageId>`;
   * rebuilt-from-memory messages lose it, so fall back to matching the raw
   * base64 payload against the session's generated images.
   */
  const resolveEditContextImages = useCallback(
    async (message: UIMessage): Promise<GeneratedImageItem[]> => {
      const parts = message.parts.filter(
        (part): part is Extract<UIMessagePart, { type: "attachment" }> =>
          part.type === "attachment" && part.attachment?.type === "image",
      );
      if (parts.length === 0) return [];
      const byId = new Map(generatedImages.map((image) => [image.id, image]));
      const found: GeneratedImageItem[] = [];
      const dataParts: Array<
        Extract<UIMessagePart, { type: "attachment" }>
      > = [];
      for (const part of parts) {
        const idMatch = part.attachment.id?.match(/^ctx-(.+)$/);
        const item = idMatch ? (byId.get(idMatch[1]) ?? null) : null;
        if (item) {
          if (!found.some((existing) => existing.id === item.id)) found.push(item);
        } else {
          dataParts.push(part);
        }
      }
      if (dataParts.length > 0) {
        const candidates = generatedImages.filter(
          (image) => !found.some((existing) => existing.id === image.id),
        );
        for (const part of dataParts) {
          const target = part.attachment.data ?? "";
          if (!target) continue;
          for (const candidate of candidates) {
            try {
              const { blob } = await fetchImageBytes(candidate.id);
              const dataUrl = await blobToDataUrl(blob);
              if (dataUrl.slice(dataUrl.indexOf(",") + 1) === target) {
                found.push(candidate);
                break;
              }
            } catch {
              // skip images that fail to load
            }
          }
        }
      }
      return found;
    },
    [generatedImages],
  );


  const handleStartEdit = useCallback(
    (message: UIMessage) => {
      if (chat.status === "streaming") return;
      setEditingMessageId(message.id);
      setEditContextImages([]);
      void resolveEditContextImages(message).then(setEditContextImages);
    },
    [chat.status, resolveEditContextImages],
  );
  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditContextImages([]);
  }, []);

  const editAvailableImages = useMemo(
    () =>
      generatedImages.filter(
        (image) =>
          !editContextImages.some((item) => item.id === image.id),
      ),
    [generatedImages, editContextImages],
  );
  const handleEditContextAdd = useCallback((image: GeneratedImageItem) => {
    setEditContextImages((current) =>
      current.some((item) => item.id === image.id)
        ? current
        : [...current, image],
    );
  }, []);
  const handleEditContextRemove = useCallback((image: GeneratedImageItem) => {
    setEditContextImages((current) =>
      current.filter((item) => item.id !== image.id),
    );
  }, []);


  // Keep the latest send body in a ref (avoids stale closures for the stale
  // dialog's "Send anyway"); the submit handler wraps it with the freshness
  // check.
  submitComposerRef.current = async (
    input,
    attachments,
    chatController,
    clear,
  ) => {
    setComposerError(null);
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;

    // Queue conflict gate — bypassed for the modal's own "send new" action
    // via submitBypassRef. Reached only while idle with a non-empty queue
    // (auto-flush drains it unless held), so the queue is paused: ask the
    // user whether this draft joins the queue or sends immediately.
    if (
      !submitBypassRef.current &&
      chatRef.current?.status !== "streaming" &&
      queuedItemsRef.current.length > 0
    ) {
      pendingManualSubmitRef.current = {
        input,
        attachments,
        chatController,
        clear,
      };
      setQueueConflictOpen(true);
      return;
    }

    // Optimistic send: the user bubble appears the moment sendMessage is
    // called below. The stale check runs in parallel and only surfaces a
    // non-blocking notice afterwards (normal sends are non-destructive).
    const stalePromise = isSessionStale();

    // Truncate-before-send: a persisted failed tail [user, assistant
    // kind:"error"] would re-enter memory — drop it first.
    const messages = chatController.messages;
    const last = messages.at(-1);
    const secondLast = messages.at(-2);
    if (
      last?.role === "assistant" &&
      metadataKind(last.metadata) === "error" &&
      secondLast?.role === "user"
    ) {
      const userMeta = readChatMessageMeta(secondLast.metadata);
      if (userMeta.clientMessageId) {
        void truncateSessionMemory({
          sessionId,
          mode: "exclude",
          clientMessageId: userMeta.clientMessageId,
        }).catch(() => {});
      }
      chatController.setMessages(messages.slice(0, -2));
      // The failed tail is gone from live parts — resync image history.
      void refreshSessionImages();
    }

    // Upload steps set composerError themselves before throwing; the catch
    // keeps the submit promise from rejecting (the composer awaits it).
    try {
      await sendDraft({
        text: trimmed,
        attachments,
        documentIds: [],
        pinnedImageIds: activeContextImages.map((image) => image.id),
      });
    } catch (error) {
      if (error instanceof Error) {
        setComposerError(error.message);
      }
      return;
    }

    clear();

    // Active image context is single-use: it was consumed by this message,
    // so clear the pins (the server also clears after the run reads them).
    if (activeContextImages.length > 0) {
      setActiveContextImages([]);
    }
    setIngestionItems([]);

    // Non-blocking freshness notice: the message was already sent (normal
    // sends are non-destructive); offer a reload so the view catches up
    // with the other window/device.
    if (await stalePromise) {
      setStaleDialog({ kind: "send" });
    }
  };

  /** Dialog "Send queue": the pending draft joins the queue; hold releases. */
  const handleQueueConflictSendQueue = useCallback(async () => {
    setQueueConflictOpen(false);
    const pending = pendingManualSubmitRef.current;
    pendingManualSubmitRef.current = null;
    if (!pending) return;
    await queueComposerDraft({
      input: pending.input,
      attachments: pending.attachments,
    });
    setQueueHold(false);
  }, [queueComposerDraft]);

  /** Dialog "Send new message": bypass the conflict gate and send now. */
  const handleQueueConflictSendNew = useCallback(async () => {
    setQueueConflictOpen(false);
    const pending = pendingManualSubmitRef.current;
    pendingManualSubmitRef.current = null;
    if (!pending) return;
    submitBypassRef.current = true;
    try {
      await submitComposerRef.current(
        pending.input,
        pending.attachments,
        pending.chatController,
        pending.clear,
      );
    } finally {
      submitBypassRef.current = false;
    }
  }, []);

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
          if (modelsStatus !== "success") return;
          const editing = queuedItemsRef.current.find(
            (item) => item.status === "editing",
          );
          if (chatRef.current?.status === "streaming") {
            if (editing) {
              await handleSubmitQueueEdit(input, attachments);
            } else {
              await queueComposerDraft({ input, attachments });
            }
            return;
          }
          // Idle + editing: the composer holds the recalled draft — commit it
          // back into the queue item (a held queue would otherwise trap the
          // submit behind the conflict gate).
          if (editing) {
            await handleSubmitQueueEdit(input, attachments);
            return;
          }
          await submitComposerRef.current(
            input,
            attachments,
            chatController,
            clear,
          );
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
                    {(message) => (
                      <ChatMessageRow
                        message={message}
                        chatStatus={chat.status}
                        lastMessageId={chat.messages.at(-1)?.id}
                        editingMessageId={editingMessageId}
                        onStartEdit={handleStartEdit}
                        onCancelEdit={handleCancelEdit}
                        onSubmitEdit={handleSubmitEdit}
                        onRevert={handleRevert}
                        generationInfo={generationInfoMap.get(message.id)}
                        editContextImages={editContextImages}
                        editAvailableImages={editAvailableImages}
                        onEditContextAdd={handleEditContextAdd}
                        onEditContextRemove={handleEditContextRemove}
                        onAddContext={handleAddContext}
                      />
                    )}
                  </Thread.Messages>

                  <Thread.Loading className="mt-4 w-full text-sm text-text-muted">
                    <AnimatedStatusText
                      label={
                        chat.status === "streaming"
                          ? "Thinking and writing"
                          : "Writing"
                      }
                    />
                  </Thread.Loading>

                  <Thread.Error className="mt-4 w-full rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger" />
                </div>
              </Thread.Viewport>

              <InsetScrollbar
                scrollRef={chatViewportRef}
                top="calc(3.5rem + 24px)"
                bottom="calc(var(--composer-dock-h, 7.5rem) + var(--chat-composer-gap, 40px))"
              />

              {/* Below the composer dock so Add as context cannot cover the field. */}
              <div
                id="chat-surface"
                className="pointer-events-none absolute inset-0 z-10"
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

                  {previousRunError ? (
                    <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in">
                      <span className="min-w-0">
                        The previous run failed — review the conversation and
                        send again.
                      </span>
                      <button
                        type="button"
                        aria-label="Dismiss failed run notice"
                        onClick={() => setPreviousRunError(false)}
                        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-danger/70 transition hover:bg-white/[0.06] hover:text-danger active:scale-[0.96]"
                      >
                        <X className="size-3.5" strokeWidth={2} />
                      </button>
                    </div>
                  ) : null}

                  <ApprovalPanel />

                  <ClarificationPanel />

                  <StaleSessionDialog
                    open={staleDialog !== null}
                    kind={staleDialog?.kind ?? "send"}
                    onReload={handleStaleReload}
                  />

                  <QueueConflictDialog
                    open={queueConflictOpen}
                    onClose={() => {
                      pendingManualSubmitRef.current = null;
                      setQueueConflictOpen(false);
                    }}
                    onSendQueue={() => void handleQueueConflictSendQueue()}
                    onSendNew={() =>
                      void handleQueueConflictSendNew().catch(() => {})
                    }
                  />

                  <ChatComposer
                    sessionId={sessionId}
                    projectId={projectId}
                    activeDocumentIds={sessionDocumentIds}
                    chatStatus={chat.status}
                    isIngesting={isIngesting}
                    composerError={composerError}
                    attachmentErrors={attachmentErrors}
                    composerInputRef={composerInputRef}
                    model={selectedModel}
                    reasoningEffort={selectedReasoningEffort}
                    onModelChange={handleModelChange}
                    onReasoningChange={handleReasoningChange}
                    onStopRun={handleStopRun}
                    onLinkedDocuments={handleLinkedDocuments}
                    onAttachmentRejected={handleAttachmentRejected}
                    onDismissAttachmentError={handleDismissAttachmentError}
                    models={models}
                    reasoningEfforts={reasoningEfforts}
                    modelsStatus={modelsStatus}
                    modelsError={modelsError}
                    onRetryModels={modelsRetry}
                    compaction={compaction}
                    contextUsage={contextUsage}
                    contextUsageError={contextUsageError}
                    webSearchEnabled={webSearchEnabled}
                    webSearchAvailable={capabilities?.webSearchAvailable ?? false}
                    onWebSearchToggle={setWebSearchEnabled}
                    imageGenerationEnabled={imageGenerationEnabled}
                    imageGenerationAvailable={
                      capabilities?.imageGenerationAvailable ?? false
                    }
                    onImageGenerationToggle={handleImageGenerationToggle}
                    imageGenSettings={imageGenSettings}
                    onImageGenSettingsChange={handleImageGenSettingsChange}
                    activeContextImages={activeContextImages}
                    onToggleImageContext={(image) => {
                      void handleToggleImageContext(image);
                    }}
                    contextSnippet={contextSnippetState.snippet}
                    contextSnippetError={contextSnippetState.error}
                    onRemoveContextSnippet={() => {
                      void contextSnippetState.remove();
                    }}
                    queuedItems={queuedItems}
                    onQueueSendNow={handleQueueSendNow}
                    onQueueRemove={queueActions.removeItem}
                    onQueueReorder={queueActions.reorder}
                    onQueueRecall={handleQueueRecall}
                    onQueueCancelEdit={handleQueueCancelEdit}
                    editHydration={editHydration}
                    clearComposerSignal={clearComposerSignal}
                    suppressOptimisticClear={autoFlushPreserveRef}
                  />
                </div>
              </div>
            </Thread.Root>
          </div>

          {/* Right doc rail — same 272px + full height as left sidebar */}
          <SessionDocumentsRail
            sessionDocuments={sessionDocuments}
            citedDocuments={citedDocuments}
            webSources={webSources}
            generatedImages={generatedImages}
            runningImageCount={runningImageParts}
            activeContextImages={activeContextImages}
            ingestionItems={ingestionItems}
            onRemoveActiveDocument={handleRemoveActiveDocument}
            removingDocumentId={removingDocumentId}
            onToggleImageContext={(image) => {
              void handleToggleImageContext(image);
            }}
          />
        </div>
      </Composer.Root>
      </CitationSessionProvider>
    </ChatProvider>
  );
}
