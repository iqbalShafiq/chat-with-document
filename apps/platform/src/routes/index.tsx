import { initialMessagesFromMemory, useChat } from "@anvia/react";
import type { UIAttachment, UIMessage } from "@anvia/react";
import { ChatProvider, Composer, Thread } from "@anvia/react-ui";
import { createFileRoute } from "@tanstack/react-router";
import { ChatMessageRow } from "#/components/chat/chat-message-row";
import { CitationSessionProvider } from "#/components/chat/citation-session-context";
import { EmptyState } from "#/components/chat/empty-state";
import { InsetScrollbar } from "#/components/chat/inset-scrollbar";
import { SessionDocumentsRail } from "#/components/chat/session-documents-panel";
import { ChatComposer } from "#/components/composer/chat-composer";
import { AppShell } from "#/components/layout/app-shell";
import {
  API_BASE,
  listSessionDocuments,
  listSessions,
  truncateSessionMemory,
  uploadDocument,
  waitForDocumentReady,
  type DocumentStatus,
  type SessionDocument,
} from "#/lib/api";
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
  ensureActiveSession,
  type SessionSummary,
} from "#/lib/session-history";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

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
  const composerDockRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);
  const [ingestionItems, setIngestionItems] = useState<
    Array<{ filename: string; status: DocumentStatus }>
  >([]);
  const [sessionDocuments, setSessionDocuments] = useState<SessionDocument[]>(
    [],
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
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
          className="flex min-h-0 w-full flex-1 overflow-hidden"
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
                className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain"
                autoScroll
              >
                <div
                  className="mx-auto flex min-h-full w-full max-w-[760px] flex-col px-3"
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
                      "flex w-full flex-col",
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
                    <Thread.ScrollToBottom className="pointer-events-auto glass inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:bg-white/12 hover:text-text active:scale-[0.98] data-[state=bottom]:invisible">
                      Latest
                    </Thread.ScrollToBottom>
                  </Thread.ViewportFooter>

                  <ChatComposer
                    chatStatus={chat.status}
                    isIngesting={isIngesting}
                    composerError={composerError}
                    composerInputRef={composerInputRef}
                  />
                </div>
              </div>
            </Thread.Root>
          </div>

          {/* Right doc rail — same 272px as left sidebar; same vertical band as chat */}
          <SessionDocumentsRail
            sessionDocuments={sessionDocuments}
            ingestionItems={ingestionItems}
          />
        </div>
      </Composer.Root>
      </CitationSessionProvider>
    </ChatProvider>
  );
}
