import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AnrealMark, AnrealWordmark } from "#/components/layout/anreal-brand";
import { CitationSessionProvider } from "#/components/chat/citation-session-context";
import {
  API_BASE,
  createChatSession,
  fetchPublicShare,
} from "#/lib/api";
import { parseMemoryMessages, type ChatUIMessage } from "#/components/chat/chat-session";
import { finalizeInterruptedTools } from "#/lib/chat/finalize-interrupted-tools";
import { getSessionUser } from "#/lib/auth-session";

/**
 * Public share page: no sidebar, no auth gate. Anonymous readers get the
 * frozen snapshot + Login/Register CTA at the bottom; signed-in readers
 * get a composer whose first submit forks the snapshot into their own
 * session and navigates to `/chat/<newId>`.
 */
export const Route = createFileRoute("/share/$shareToken")({
  component: SharePage,
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
});

function SharePage() {
  const { shareToken } = Route.useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "ready" | "missing">(
    "loading",
  );
  const [title, setTitle] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatUIMessage[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMessages(null);
    void (async () => {
      try {
        const snapshot = await fetchPublicShare(shareToken);
        if (cancelled) return;
        setTitle(snapshot.title);
        setOwnerName(snapshot.ownerName);
        setCreatedAt(snapshot.createdAt);
        setMessages(finalizeInterruptedTools(parseMemoryMessages(snapshot.messages)));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("missing");
      }
      try {
        const user = await getSessionUser();
        if (!cancelled) {
          setSignedIn(Boolean(user));
          setAuthChecked(true);
        }
      } catch {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  const loginHref = `/login?redirect=${encodeURIComponent(`/share/${shareToken}`)}`;
  const registerHref = `/register?redirect=${encodeURIComponent(`/share/${shareToken}`)}`;

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden text-text">
      <div className="relative z-[1] flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="glass-top-bar flex h-14 shrink-0 items-center gap-2.5 px-3 md:px-4">
          <AnrealMark />
          <AnrealWordmark className="truncate" />
          <span className="ml-1 hidden shrink-0 rounded-full bg-white/[0.07] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted sm:inline">
            Shared
          </span>
          <span className="min-w-0 flex-1" />
          {!authChecked ? null : signedIn ? (
            <Link
              to="/"
              className="glass glass-interactive inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]"
            >
              Open my chats
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                search={{ redirect: `/share/${shareToken}` }}
                className="inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98]"
              >
                Log in
              </Link>
              <Link
                to="/register"
                search={{ redirect: `/share/${shareToken}` }}
                className="glass glass-interactive inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]"
              >
                Sign up
              </Link>
            </>
          )}
        </header>

        <main className="relative flex min-h-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {status === "loading" ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 animate-fade-up">
                <AnrealMark className="opacity-80" />
                <div className="skeleton-shimmer h-4 w-40 rounded-full" />
                <p className="text-sm text-text-muted">Loading shared chat…</p>
              </div>
            ) : null}

            {status === "missing" ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center animate-fade-up">
                <AnrealMark className="opacity-80" />
                <h1 className="text-lg font-semibold text-text">
                  Shared link not found
                </h1>
                <p className="max-w-md text-sm text-text-muted">
                  This link was deactivated or the original chat was deleted.
                  Ask the owner for a fresh link.
                </p>
                <Link
                  to="/"
                  className="glass glass-interactive mt-1 inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]"
                >
                  New chat
                </Link>
              </div>
            ) : null}

            {status === "ready" && messages ? (
              <ShareThread
                token={shareToken}
                title={title}
                ownerName={ownerName}
                createdAt={createdAt}
                messages={messages}
                signedIn={signedIn}
                authChecked={authChecked}
                loginHref={loginHref}
                registerHref={registerHref}
                onForked={(sessionId) => {
                  void navigate({
                    to: "/chat/$sessionId",
                    params: { sessionId },
                  });
                }}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function ShareThread({
  token,
  title,
  ownerName,
  createdAt,
  messages,
  signedIn,
  authChecked,
  loginHref,
  registerHref,
  onForked,
}: {
  token: string;
  title: string | null;
  ownerName: string | null;
  createdAt: string | null;
  messages: ChatUIMessage[];
  signedIn: boolean;
  authChecked: boolean;
  loginHref: string;
  registerHref: string;
  onForked: (sessionId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="chat-scroll-bleed min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full min-w-0 max-w-[760px] flex-col px-3 pb-8 pt-6">
          <div className="mb-6 rounded-2xl border border-hairline bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-faint">
              Shared chat snapshot
            </p>
            <h1 className="mt-1 text-lg font-semibold text-text">
              {title?.trim() || "Shared chat"}
            </h1>
            <p className="mt-1 text-xs text-text-muted">
              {ownerName ? `Shared by ${ownerName}` : "Shared anonymously"}
              {createdAt
                ? ` · ${new Date(createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                : ""}
              {" · "}Frozen copy — new messages in the original never update this link.
            </p>
          </div>

          <CitationSessionProvider sessionDocuments={[]}>
            <SharedSnapshotThread messages={messages} />
          </CitationSessionProvider>
        </div>
      </div>

      <div className="shrink-0 border-t border-hairline px-3 py-3">
        <div className="mx-auto w-full max-w-[760px]">
          {!authChecked ? (
            <div className="skeleton-shimmer h-12 w-full rounded-2xl" />
          ) : signedIn ? (
            <ShareForkCta
              token={token}
              title={title}
              messages={messages}
              onForked={onForked}
            />
          ) : (
            <div className="flex flex-col items-center gap-2.5 rounded-2xl bg-white/[0.04] px-4 py-4 text-center animate-fade-in">
              <p className="text-sm text-text">
                Log in or create an account to continue this chat as your own
                copy.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <a
                  href={loginHref}
                  className="inline-flex min-h-10 cursor-pointer items-center rounded-full px-5 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98]"
                >
                  Log in
                </a>
                <a
                  href={registerHref}
                  className="glass glass-interactive inline-flex min-h-10 cursor-pointer items-center rounded-full px-5 text-sm font-medium text-text transition active:scale-[0.98]"
                >
                  Sign up
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only thread renderer: plain div/article wrappers carrying the same
 * data-role hooks the spacing CSS expects. ChatMessageRow needs a live
 * useChat/useMessage context, so snapshot rows render through a dedicated
 * static bubble instead.
 */
function SharedSnapshotThread({ messages }: { messages: ChatUIMessage[] }) {
  return (
    <div className="flex w-full min-w-0 flex-col [&>*]:min-w-0 [&>*+*]:mt-1 [&>[data-role=user]+*]:mt-4 [&>*+[data-role=user]]:mt-4">
      {messages.map((message) => (
        <SharedSnapshotRow key={message.id} message={message} />
      ))}
    </div>
  );
}

function messageText(message: ChatUIMessage): string {
  // UIMessage (live stream shape) vs completion Message (snapshot from the
  // server): accept both so frozen snapshots always render.
  const raw = message as unknown as {
    parts?: unknown;
    content?: unknown;
  };
  if (Array.isArray(raw.parts)) {
    const fromParts = (raw.parts as Array<{ type?: unknown; text?: unknown }>)
      .filter((part) => part?.type === "text")
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (fromParts.trim()) return fromParts;
  }
  if (typeof raw.content === "string") return raw.content;
  if (Array.isArray(raw.content)) {
    return (raw.content as Array<{ text?: unknown }>)
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function SharedSnapshotRow({ message }: { message: ChatUIMessage }) {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = messageText(message).trim();
  if (!text) return null;
  const isUser = message.role === "user";
  return (
    <article
      data-role={message.role}
      className={`flex w-full min-w-0 flex-col ${isUser ? "items-end" : "items-start"}`}
    >
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl bg-accent px-3.5 py-2.5 text-sm leading-relaxed text-white"
            : "w-full min-w-0 rounded-2xl bg-white/[0.04] px-3.5 py-2.5 text-sm leading-relaxed text-text"
        }
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </article>
  );
}

/**
 * Signed-in CTA: one textarea (reuse the composer look via plain markup,
 * not the full ChatComposer — that shell requires a live useChat session).
 * Submit forks the frozen snapshot into the viewer's own session, sends the
 * first message there, and navigates to `/chat/<newId>`.
 */
function ShareForkCta({
  token,
  title,
  messages,
  onForked,
}: {
  token: string;
  title: string | null;
  messages: ChatUIMessage[];
  onForked: (sessionId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

  const canSend = draft.trim().length > 0 && !forking;

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || forking) return;
    setForking(true);
    setForkError(null);
    try {
      // New session owned by the viewer (standalone). History is seeded
      // from the frozen snapshot server-side; from here the fork is fully
      // independent — revoke/delete of the source never touches it.
      const session = await createChatSession({ projectId: null });
      const seedMessages = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-40);
      const response = await fetch(`${API_BASE}/api/chat/fork`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          forkedFrom: { token, title: title ?? "Shared chat" },
          messages: seedMessages,
          firstMessage: text,
        }),
      });
      if (!response.ok) throw new Error("Could not start your copy");
      const data = (await response.json()) as { sessionId?: string };
      setDraft("");
      onForked(data.sessionId ?? session.sessionId);
    } catch (error) {
      setForkError(
        error instanceof Error ? error.message : "Could not start your copy",
      );
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {forkError ? (
        <div
          role="alert"
          className="rounded-2xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger animate-fade-in"
        >
          {forkError}
        </div>
      ) : null}
      <p className="text-xs text-text-muted">
        Continue this chat as your own copy — the shared link stays frozen.
      </p>
      <div className="glass-composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
        <textarea
          aria-label="Continue this shared chat"
          placeholder="Ask a follow-up…"
          rows={1}
          value={draft}
          disabled={forking}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          className="composer-input chat-scroll block min-h-[1.625em] w-full min-w-0 resize-none bg-transparent px-1 text-sm leading-relaxed text-text"
        />
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void handleSend()}
            className="glass glass-interactive inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {forking ? "Starting your copy…" : "Send as my copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
