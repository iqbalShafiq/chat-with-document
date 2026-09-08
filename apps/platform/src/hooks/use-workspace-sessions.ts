import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiAuthError,
  getOrCreateEmptyChatSession,
  listActiveRuns,
  listSessions,
  markSessionRead,
} from "#/lib/api";
import {
  findEmptyNewChat,
  sessionSummaryFromDraft,
  type SessionSummary,
} from "#/lib/session-history";

const SESSIONS_PAGE_SIZE = 30;
const ACTIVE_RUNS_POLL_MS = 10_000;

/**
 * Shared session list + active-run polling for the workspace shell.
 * One instance lives in the workspace layout so chat routes never duplicate
 * the loader, the poller, or the unread-dot bookkeeping.
 */
export function useWorkspaceSessions(input: {
  projectId: string | null;
  activeSessionId: string;
  onAuthFailure: () => void;
}): {
  sessions: SessionSummary[];
  nextCursor: string | null;
  sessionsLoading: boolean;
  sessionsLoadingMore: boolean;
  sessionsError: string | null;
  activeRuns: ReadonlySet<string>;
  loadFirstPage: () => Promise<void>;
  loadMore: () => Promise<void>;
  refreshQuiet: () => Promise<void>;
  removeSession: (sessionId: string) => void;
  renameSessionInList: (sessionId: string, title: string) => void;
  replaceWithDraft: (projectId: string | null) => Promise<SessionSummary>;
} {
  const { projectId, activeSessionId, onAuthFailure } = input;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeRuns, setActiveRuns] = useState<ReadonlySet<string>>(new Set());

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeRunsRef = useRef(activeRuns);
  activeRunsRef.current = activeRuns;
  const onAuthFailureRef = useRef(onAuthFailure);
  onAuthFailureRef.current = onAuthFailure;
  const loadMoreLock = useRef(false);

  const loadFirstPage = useCallback(async () => {
    const scopeProjectId = projectIdRef.current;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const page = await listSessions({
        limit: SESSIONS_PAGE_SIZE,
        projectId: scopeProjectId ?? undefined,
      });
      const items = page.items.map((session) =>
        session.sessionId === activeSessionIdRef.current
          ? { ...session, unread: false }
          : session,
      );
      setSessions(items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        onAuthFailureRef.current();
        return;
      }
      console.error("[sessions] failed to load", error);
      setSessionsError("Could not load conversations");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = nextCursor;
    if (!cursor || loadMoreLock.current) return;
    loadMoreLock.current = true;
    setSessionsLoadingMore(true);
    try {
      const page = await listSessions({
        cursor,
        limit: SESSIONS_PAGE_SIZE,
        projectId: projectIdRef.current ?? undefined,
      });
      setSessions((current) => {
        const seen = new Set(current.map((s) => s.sessionId));
        return [
          ...current,
          ...page.items.filter((s) => !seen.has(s.sessionId)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      console.error("[sessions] failed to load more", error);
    } finally {
      setSessionsLoadingMore(false);
      loadMoreLock.current = false;
    }
  }, [nextCursor]);

  /** After a stream ends, refresh titles/order from the server only. */
  const refreshQuiet = useCallback(async () => {
    try {
      const page = await listSessions({
        limit: SESSIONS_PAGE_SIZE,
        projectId: projectIdRef.current ?? undefined,
      });
      setSessions(page.items);
      setNextCursor(page.nextCursor);
      setSessionsError(null);
    } catch (error) {
      console.error("[sessions] quiet refresh failed", error);
    }
  }, []);

  const reconcileAfterRunChange = useCallback(async () => {
    try {
      const page = await listSessions({
        limit: SESSIONS_PAGE_SIZE,
        projectId: projectIdRef.current ?? undefined,
      });
      setSessions((current) => {
        const fetchedIds = new Set(page.items.map((s) => s.sessionId));
        return [
          ...page.items,
          ...current.filter((s) => !fetchedIds.has(s.sessionId)),
        ];
      });
      setNextCursor((current) =>
        current === null ? page.nextCursor : current,
      );
    } catch (error) {
      console.error("[sessions] silent refresh failed", error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const runs = await listActiveRuns();
        if (cancelled) return;
        const next = new Set(runs.map((run) => run.sessionId));
        const prev = activeRunsRef.current;
        const changed =
          next.size !== prev.size || [...next].some((id) => !prev.has(id));
        setActiveRuns(next);
        if (changed) {
          await reconcileAfterRunChange();
        }
      } catch (error) {
        if (error instanceof ApiAuthError) {
          onAuthFailureRef.current();
          return;
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, ACTIVE_RUNS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reconcileAfterRunChange]);

  // Opening a session clears its unread marker locally; the server mark-read
  // POST commits separately so the dot never reappears on navigation.
  useEffect(() => {
    if (!activeSessionId) return;
    setSessions((current) =>
      current.map((s) =>
        s.sessionId === activeSessionId ? { ...s, unread: false } : s,
      ),
    );
    void markSessionRead(activeSessionId).catch(() => {});
  }, [activeSessionId]);

  // Session scope follows the route: reset and reload when the project changes.
  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage, projectId]);

  const removeSession = useCallback((sessionId: string) => {
    setSessions((current) =>
      current.filter((s) => s.sessionId !== sessionId),
    );
  }, []);

  const renameSessionInList = useCallback(
    (sessionId: string, title: string) => {
      setSessions((current) =>
        current.map((s) =>
          s.sessionId === sessionId ? { ...s, title } : s,
        ),
      );
    },
    [],
  );

  /**
   * Resolve the active session for a scope: reuse a visible empty draft,
   * else the most recent chat, else create the single server draft.
   * Never invents client UUIDs.
   */
  const replaceWithDraft = useCallback(
    async (scopeProjectId: string | null): Promise<SessionSummary> => {
      const page = await listSessions({
        limit: SESSIONS_PAGE_SIZE,
        projectId: scopeProjectId ?? undefined,
      });
      const empty = findEmptyNewChat(page.items, activeRunsRef.current);
      const pick = empty ?? page.items[0] ?? null;
      if (pick) {
        setSessions(page.items);
        setNextCursor(page.nextCursor);
        return pick;
      }
      const draft = await getOrCreateEmptyChatSession({
        projectId: scopeProjectId,
      });
      const row = sessionSummaryFromDraft(draft);
      setSessions([row]);
      setNextCursor(null);
      return row;
    },
    [],
  );

  return {
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
    replaceWithDraft,
  };
}
