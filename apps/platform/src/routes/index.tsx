import { initialMessagesFromMemory, useChat } from "@anvia/react";
import type { UIAttachment, UIMessage } from "@anvia/react";
import { ChatProvider, Thread } from "@anvia/react-ui";
import { createFileRoute } from "@tanstack/react-router";
import { ChatMessageRow } from "#/components/chat/chat-message-row";
import { EmptyState } from "#/components/chat/empty-state";
import { ChatComposer } from "#/components/composer/chat-composer";
import { AppShell } from "#/components/layout/app-shell";
import {
  API_BASE,
  listSessionDocuments,
  listSessions,
  uploadDocument,
  waitForDocumentReady,
  type DocumentStatus,
  type SessionDocument,
} from "#/lib/api";
import {
  ensureActiveSession,
  type SessionSummary,
} from "#/lib/session-history";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SESSION_STORAGE_KEY = "chat.sessionId";
const SESSIONS_PAGE_SIZE = 30;

export const Route = createFileRoute("/")({
  component: Home,
});

function createSessionId() {
  return crypto.randomUUID();
}

function readStoredSessionId() {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch {
    // ignore storage access errors
  }
  return null;
}

function persistSessionId(sessionId: string) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // ignore storage access errors
  }
}

function documentIdsFromMetadata(metadata: UIMessage["metadata"]): string[] {
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Array.isArray(metadata.documentIds)
  ) {
    return metadata.documentIds.filter(
      (id): id is string => typeof id === "string",
    );
  }

  return [];
}

async function resolveAttachmentFile(attachment: UIAttachment) {
  if (attachment.url?.startsWith("blob:")) {
    const response = await fetch(attachment.url);
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Attachment is empty: ${attachment.name ?? attachment.id}`);
    }
    return new File([blob], attachment.name ?? "document", {
      type: attachment.mediaType ?? "application/octet-stream",
    });
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
    return new File([blob], attachment.name ?? "document", {
      type: attachment.mediaType ?? (blob.type || "application/octet-stream"),
    });
  }

  throw new Error(`Unable to read attachment: ${attachment.name ?? attachment.id}`);
}

function Home() {
  const [sessionId, setSessionId] = useState(() => {
    return readStoredSessionId() ?? createSessionId();
  });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(
    null,
  );
  const loadMoreLock = useRef(false);
  // Always read latest sessionId inside async callbacks without re-creating loaders.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const loadSessionsFirstPage = useCallback(async () => {
    const activeId = sessionIdRef.current;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const page = await listSessions({ limit: SESSIONS_PAGE_SIZE });
      setSessions(ensureActiveSession(page.items, activeId));
      setNextCursor(page.nextCursor);
    } catch (error) {
      console.error("[sessions] failed to load", error);
      setSessionsError("Could not load conversations");
      setSessions((current) => ensureActiveSession(current, activeId));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadMoreSessions = useCallback(async () => {
    if (!nextCursor || loadMoreLock.current || sessionsLoadingMore) return;
    loadMoreLock.current = true;
    setSessionsLoadingMore(true);
    try {
      const page = await listSessions({
        cursor: nextCursor,
        limit: SESSIONS_PAGE_SIZE,
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

  /** After a stream ends, refresh titles/order without wiping local-only drafts. */
  const refreshSessionsQuiet = useCallback(async () => {
    const activeId = sessionIdRef.current;
    try {
      const page = await listSessions({ limit: SESSIONS_PAGE_SIZE });
      setSessions((current) => {
        const remoteIds = new Set(page.items.map((s) => s.sessionId));
        const localDrafts = current.filter((s) => !remoteIds.has(s.sessionId));
        return ensureActiveSession([...localDrafts, ...page.items], activeId);
      });
      setNextCursor(page.nextCursor);
      setSessionsError(null);
    } catch (error) {
      console.error("[sessions] quiet refresh failed", error);
    }
  }, []);

  // Bootstrap session list once on mount (not on every chat switch).
  useEffect(() => {
    void loadSessionsFirstPage();
  }, [loadSessionsFirstPage]);

  // Load messages whenever the active session changes.
  useEffect(() => {
    persistSessionId(sessionId);
    let cancelled = false;
    setInitialMessages(null);

    void (async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) throw new Error("Failed to load messages");
        const data = await response.json();
        if (!cancelled) {
          setInitialMessages(initialMessagesFromMemory(data));
        }
      } catch {
        if (!cancelled) {
          setInitialMessages([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleSelectSession = (nextSessionId: string) => {
    if (nextSessionId === sessionId) return;
    setSessionId(nextSessionId);
  };

  const handleNewSession = () => {
    const nextSessionId = createSessionId();
    setSessions((current) =>
      ensureActiveSession(
        current.filter((s) => s.sessionId !== nextSessionId),
        nextSessionId,
      ),
    );
    setSessionId(nextSessionId);
  };

  const activeTitle = useMemo(() => {
    return (
      sessions.find((s) => s.sessionId === sessionId)?.title ?? "New chat"
    );
  }, [sessionId, sessions]);

  return (
    <AppShell
      sessions={sessions}
      activeSessionId={sessionId}
      activeTitle={activeTitle}
      sessionsLoading={sessionsLoading}
      sessionsLoadingMore={sessionsLoadingMore}
      sessionsError={sessionsError}
      hasMoreSessions={Boolean(nextCursor)}
      onSelectSession={handleSelectSession}
      onNewChat={handleNewSession}
      onLoadMoreSessions={() => {
        void loadMoreSessions();
      }}
      onRetrySessions={() => {
        void loadSessionsFirstPage();
      }}
    >
      {initialMessages === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 animate-fade-in">
          <div className="skeleton-shimmer h-4 w-40 rounded-full" />
          <p className="text-sm text-text-muted">Loading conversation…</p>
        </div>
      ) : (
        <ChatSession
          key={sessionId}
          sessionId={sessionId}
          initialMessages={initialMessages}
          onStreamSettled={() => {
            void refreshSessionsQuiet();
          }}
        />
      )}
    </AppShell>
  );
}

function ChatSession({
  sessionId,
  initialMessages,
  onStreamSettled,
}: {
  sessionId: string;
  initialMessages: UIMessage[];
  onStreamSettled: () => void;
}) {
  const composerInputRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);
  const [ingestionItems, setIngestionItems] = useState<
    Array<{ filename: string; status: DocumentStatus }>
  >([]);
  const [sessionDocuments, setSessionDocuments] = useState<SessionDocument[]>(
    [],
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);

  const refreshSessionDocuments = useCallback(async () => {
    try {
      const documents = await listSessionDocuments(sessionId);
      setSessionDocuments(documents);
    } catch {
      // Keep the previous list if refresh fails.
    }
  }, [sessionId]);

  const chat = useChat({
    endpoint: `${API_BASE}/api/chat`,
    initialMessages,
    createRequest: ({ coreMessages, uiMessages }) => {
      const last = uiMessages.at(-1);
      const documentIds = documentIdsFromMetadata(last?.metadata);

      return {
        messages: coreMessages,
        stream: true as const,
        sessionId,
        documentIds,
      };
    },
  });

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
      onStreamSettled();
      focusComposer();
    }
    wasStreamingRef.current = chat.status === "streaming";
  }, [chat.status, focusComposer, onStreamSettled]);

  useEffect(() => {
    focusComposer();
  }, [focusComposer]);

  useEffect(() => {
    setSessionDocuments([]);
    void refreshSessionDocuments();
  }, [refreshSessionDocuments]);

  return (
    <ChatProvider controller={chat}>
      {/*
        One scrollport owns messages + sticky composer so both share the exact
        same content width (absolute overlay was offset by the scrollbar).
      */}
      <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        <Thread.Root className="relative min-h-0 flex-1 overflow-hidden">
          <Thread.Viewport
            className="chat-scroll absolute inset-0 overflow-y-auto overscroll-contain"
            autoScroll
          >
            <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col px-3">
              {/*
                Grows between top bar clearance and sticky composer so empty
                state can center exactly in that band.
              */}
              <div className="flex min-h-0 flex-1 flex-col pt-[calc(3.5rem+1rem)] md:pt-[calc(3.5rem+1.5rem)]">
                <Thread.Empty className="flex min-h-0 flex-1 flex-col">
                  <EmptyState />
                </Thread.Empty>

                <Thread.Suggestions className="mb-4 flex w-full flex-wrap gap-2" />

                <Thread.Messages className="grid w-full gap-4">
                  {() => (
                    <ChatMessageRow
                      chatStatus={chat.status}
                      lastMessageId={chat.messages.at(-1)?.id}
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

              {/* Sticky dock: Latest sits above the field; same column width */}
              <div className="sticky bottom-0 z-20 -mx-3 px-3 pb-3 pt-2 md:pb-4">
                <Thread.ViewportFooter className="mb-2 flex justify-center">
                  <Thread.ScrollToBottom className="glass inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:bg-white/12 hover:text-text active:scale-[0.98] data-[state=bottom]:invisible">
                    Latest
                  </Thread.ScrollToBottom>
                </Thread.ViewportFooter>

                <ChatComposer
                  chatStatus={chat.status}
                  isIngesting={isIngesting}
                  sessionDocuments={sessionDocuments}
                  ingestionItems={ingestionItems}
                  composerError={composerError}
                  composerInputRef={composerInputRef}
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

                    if (attachments.length > 0) {
                      setIsIngesting(true);
                      setIngestionItems([]);

                      try {
                        for (const attachment of attachments) {
                          const file = await resolveAttachmentFile(attachment);
                          if (file.size === 0) {
                            throw new Error(`File is empty: ${file.name}`);
                          }

                          setIngestionItems((current) => [
                            ...current,
                            { filename: file.name, status: "uploading" },
                          ]);

                          const uploaded = await uploadDocument({
                            sessionId,
                            file,
                          });

                          const ready = await waitForDocumentReady({
                            sessionId,
                            documentId: uploaded.id,
                            onStatus: (status) => {
                              setIngestionItems((current) =>
                                current.map((item) =>
                                  item.filename === file.name
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
                      metadata: { sessionId, documentIds, attachedDocuments },
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
                />
              </div>
            </div>
          </Thread.Viewport>
        </Thread.Root>
      </div>
    </ChatProvider>
  );
}
