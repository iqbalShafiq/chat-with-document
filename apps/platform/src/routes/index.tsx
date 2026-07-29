import { initialMessagesFromMemory, useChat } from "@anvia/react";
import type { UIAttachment, UIMessage, UseChatStatus } from "@anvia/react";
import {
  ChatProvider,
  Composer,
  Message,
  Thread,
  useMessage,
} from "@anvia/react-ui";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Paperclip,
  Plus,
  RefreshCw,
  FileText,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { UploadingDocumentsSection } from "#/components/uploading-documents-section";
import { ToolActivityPanel } from "#/components/tool-activity-panel";
import { MathMarkdown } from "#/components/math-markdown";
import {
  API_BASE,
  listSessionDocuments,
  uploadDocument,
  waitForDocumentReady,
  type DocumentStatus,
  type SessionDocument,
} from "#/lib/api";

const SESSION_STORAGE_KEY = "chat.sessionId";

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

function mergeSessionIds(sessionId: string, sessionIds: string[]) {
  return [sessionId, ...sessionIds.filter((id) => id !== sessionId)];
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
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
    // Anvia stores File attachments as raw base64 (no data: prefix).
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
  const [sessionIds, setSessionIds] = useState<string[]>([sessionId]);
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(
    null,
  );

  const refreshSessions = useCallback(async (activeSessionId: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/chat/sessions`);
      if (!response.ok) throw new Error("Failed to load sessions");
      const data = (await response.json()) as string[];
      setSessionIds(mergeSessionIds(activeSessionId, data));
    } catch {
      setSessionIds((current) => mergeSessionIds(activeSessionId, current));
    }
  }, []);

  useEffect(() => {
    persistSessionId(sessionId);
    let cancelled = false;

    setInitialMessages(null);

    void (async () => {
      await refreshSessions(sessionId);

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
  }, [refreshSessions, sessionId]);

  const handleSelectSession = (nextSessionId: string) => {
    if (nextSessionId === sessionId) return;
    setSessionId(nextSessionId);
  };

  const handleNewSession = () => {
    const nextSessionId = createSessionId();
    setSessionIds((current) => mergeSessionIds(nextSessionId, current));
    setSessionId(nextSessionId);
  };

  return (
    <div className="flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-zinc-50 text-zinc-900">
      <header className="shrink-0 border-b border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <h1 className="shrink-0 text-sm font-semibold tracking-tight text-zinc-900">
            Chat
          </h1>
          <div className="flex min-w-0 items-center gap-2">
            <SessionDropdown
              sessionId={sessionId}
              sessionIds={sessionIds}
              onSelect={handleSelectSession}
            />
            <button
              type="button"
              onClick={handleNewSession}
              aria-label="New session"
              title="New session"
              className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 active:scale-[0.98]"
            >
              <Plus className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </header>

      {initialMessages === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          Loading session...
        </div>
      ) : (
        <ChatSession
          key={sessionId}
          sessionId={sessionId}
          initialMessages={initialMessages}
          onStreamSettled={() => {
            void refreshSessions(sessionId);
          }}
        />
      )}
    </div>
  );
}

function SessionDropdown({
  sessionId,
  sessionIds,
  onSelect,
}: {
  sessionId: string;
  sessionIds: string[];
  onSelect: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const buttonId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        className="group inline-flex min-h-11 w-[min(100%,18rem)] cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-left shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 focus-visible:border-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-600/20 focus-visible:outline-none active:scale-[0.99]"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[10px] font-medium tracking-wide text-zinc-400 uppercase">
            Session
          </span>
          <span className="truncate font-mono text-xs font-medium text-zinc-800">
            {shortSessionId(sessionId)}
          </span>
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-zinc-400 transition duration-200 group-hover:text-zinc-600 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={buttonId}
          className="absolute top-[calc(100%+0.5rem)] right-0 z-20 w-[min(calc(100vw-2rem),22rem)] overflow-hidden rounded-2xl border border-zinc-200/80 bg-white/95 shadow-[0_12px_40px_-12px_rgb(24_24_27/0.35)] backdrop-blur-md"
        >
          <div className="border-b border-zinc-100 px-3 py-2.5">
            <p className="text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
              Sessions
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {sessionIds.length} conversation
              {sessionIds.length === 1 ? "" : "s"}
            </p>
          </div>

          <ul className="chat-scroll max-h-64 overflow-y-auto p-1.5">
            {sessionIds.map((id) => {
              const selected = id === sessionId;
              return (
                <li key={id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onSelect(id);
                      setOpen(false);
                    }}
                    className={`flex w-full min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition active:scale-[0.99] ${
                      selected
                        ? "bg-emerald-50 text-emerald-900"
                        : "text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                        selected
                          ? "border-emerald-500 bg-emerald-500 text-white"
                          : "border-zinc-200 bg-white text-transparent"
                      }`}
                    >
                      <Check className="size-3" strokeWidth={2.5} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs font-medium">
                        {id}
                      </span>
                      {selected ? (
                        <span className="mt-0.5 block text-[11px] font-medium text-emerald-700">
                          Current session
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ChatMessageParts({
  chatStatus,
  lastMessageId,
}: {
  chatStatus: UseChatStatus;
  lastMessageId?: string;
}) {
  const { message } = useMessage();

  return (
    <Message.Parts
      stream={{
        isStreaming:
          chatStatus === "streaming" && lastMessageId === message.id,
        resetKey: message.id,
        flushImmediately: chatStatus === "error",
      }}
    >
      {(part) => {
        if (part.type === "text") {
          return (
            <Message.Part className="[&_a]:text-emerald-700 [&_a]:underline [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-zinc-900 [&_pre]:p-3 [&_pre]:text-zinc-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.katex-display]:my-3 [&_.katex]:text-[1.05em] group-data-[role=user]:[&_code]:bg-zinc-800 group-data-[role=user]:[&_a]:text-emerald-300">
              <MathMarkdown />
            </Message.Part>
          );
        }

        if (part.type === "attachment") {
          return (
            <Message.Part className="mt-2">
              <Message.Attachment className="block overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm" />
            </Message.Part>
          );
        }

        if (part.type === "reasoning") {
          return (
            <Message.Part className="mt-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
              <p className="font-medium">Reasoning</p>
              <p className="mt-1 whitespace-pre-wrap opacity-90">{part.text}</p>
            </Message.Part>
          );
        }

        if (part.type === "tool") {
          return (
            <Message.Part className="mt-2 space-y-2">
              <ToolActivityPanel part={part} />
              <Message.Tool
                className="rounded-xl border border-zinc-200 bg-white p-3 text-xs text-zinc-600 shadow-sm data-[state=output-available]:border-emerald-300 data-[state=output-error]:border-rose-300"
                renderWhen="always"
              />
            </Message.Part>
          );
        }

        return <Message.Part />;
      }}
    </Message.Parts>
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
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden">
        <Thread.Root className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
          <Thread.Viewport
            className="chat-scroll min-h-0 overflow-y-auto overscroll-contain px-4 py-6"
            autoScroll
          >
            <Thread.Empty className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center gap-2 text-center">
              <p className="text-lg font-medium tracking-tight text-zinc-900">
                Ask your first question
              </p>
              <p className="max-w-sm text-sm leading-relaxed text-zinc-500">
                Type a message below to start the conversation.
              </p>
            </Thread.Empty>

            <Thread.Suggestions className="mx-auto mb-4 flex w-full max-w-3xl flex-wrap gap-2" />

            <Thread.Messages className="mx-auto grid w-full max-w-3xl gap-6">
              {() => (
                <Message.Root className="group grid gap-2 data-[role=user]:justify-items-end data-[role=assistant]:justify-items-start">
                  <Message.Content className="max-w-[min(100%,42rem)] text-sm leading-relaxed group-data-[role=user]:rounded-2xl group-data-[role=user]:bg-zinc-900 group-data-[role=user]:px-4 group-data-[role=user]:py-3 group-data-[role=user]:text-zinc-50 group-data-[role=assistant]:text-zinc-800">
                    <ChatMessageParts
                      chatStatus={chat.status}
                      lastMessageId={chat.messages.at(-1)?.id}
                    />
                  </Message.Content>

                  <Message.Actions className="mt-1.5 flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100 group-data-[role=user]:justify-end">
                    <Message.Copy
                      aria-label="Copy"
                      className="inline-flex cursor-pointer p-0 text-zinc-400 transition hover:text-zinc-700 active:scale-[0.98]"
                    >
                      <Copy className="size-4" strokeWidth={1.75} />
                    </Message.Copy>
                    <Message.Regenerate
                      aria-label="Retry"
                      className="inline-flex cursor-pointer p-0 text-zinc-400 transition hover:text-zinc-700 active:scale-[0.98]"
                    >
                      <RefreshCw className="size-4" strokeWidth={1.75} />
                    </Message.Regenerate>
                  </Message.Actions>
                </Message.Root>
              )}
            </Thread.Messages>

            <Thread.Loading className="mx-auto mt-4 w-full max-w-3xl text-sm text-zinc-500">
              {chat.status === "streaming"
                ? "Assistant is thinking and writing..."
                : "Assistant is writing..."}
            </Thread.Loading>

            <Thread.Error className="mx-auto mt-4 w-full max-w-3xl rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" />

            <Thread.ViewportFooter className="sticky bottom-4 flex justify-center">
              <Thread.ScrollToBottom className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50 active:scale-[0.98] data-[state=bottom]:invisible">
                Latest
              </Thread.ScrollToBottom>
            </Thread.ViewportFooter>
          </Thread.Viewport>

          <Composer.Root
            className="mx-auto mb-4 flex w-[min(760px,calc(100%-32px))] shrink-0 flex-col gap-1"
            submitMessage={async ({ input, attachments, chat: chatController, clear }) => {
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

              await chatController.sendMessage({
                text: trimmed,
                metadata: { sessionId, documentIds },
                attachments: attachments.map((attachment) => ({
                  id: attachment.id,
                  type: attachment.type,
                  name: attachment.name,
                  mediaType: attachment.mediaType,
                  url: attachment.url,
                })),
              });

              clear();
              setIngestionItems([]);
            }}
          >
            {sessionDocuments.length > 0 ? (
              <CollapsibleDocumentSection title="Active Document">
                <ul className="doc-chip-scroll flex list-none flex-nowrap gap-2 overflow-x-auto overscroll-x-contain p-0 pb-0.5">
                  {sessionDocuments.map((doc) => (
                    <li
                      key={doc.id}
                      className="inline-flex min-h-11 w-max max-w-[min(280px,75vw)] shrink-0 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
                      title={doc.firstPageSummary || doc.filename}
                    >
                      <FileText
                        className="size-4 shrink-0 text-emerald-700"
                        strokeWidth={1.75}
                      />
                      <span className="truncate font-medium">{doc.filename}</span>
                    </li>
                  ))}
                </ul>
              </CollapsibleDocumentSection>
            ) : null}

            <UploadingDocumentsSection ingestionItems={ingestionItems} />

            {composerError ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {composerError}
              </div>
            ) : null}

            <div className="mt-1 flex items-end gap-2">
              <Composer.AddAttachment
                accept=".pdf,.png,.jpg,.jpeg,.webp"
                multiple
                aria-label="Attach document"
                title="Attach document"
                className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isIngesting || chat.status === "streaming"}
              >
                <Paperclip className="size-4" strokeWidth={1.75} />
              </Composer.AddAttachment>

              <Composer.Input
                ref={composerInputRef}
                className="composer-input flex min-w-0 flex-1 items-center rounded-full border border-zinc-200 bg-white px-4 text-sm leading-relaxed text-zinc-900 shadow-sm transition focus-within:border-emerald-600 focus-within:ring-2 focus-within:ring-emerald-600/20"
                minRows={1}
                maxRows={4}
                placeholder="Message Anvia..."
                disabled={isIngesting}
              />

              {chat.status === "streaming" ? (
                <Composer.Stop
                  aria-label="Stop"
                  title="Stop"
                  className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-zinc-900 text-white shadow-sm transition hover:bg-zinc-800 active:scale-[0.98]"
                >
                  <Square className="size-3.5 fill-current" strokeWidth={0} />
                </Composer.Stop>
              ) : (
                <Composer.Submit
                  aria-label={isIngesting ? "Processing document" : "Send"}
                  title={isIngesting ? "Processing document" : "Send"}
                  disabled={isIngesting}
                  className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-emerald-700 text-white shadow-sm transition hover:bg-emerald-600 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </Composer.Submit>
              )}
            </div>
          </Composer.Root>
        </Thread.Root>
      </div>
    </ChatProvider>
  );
}
