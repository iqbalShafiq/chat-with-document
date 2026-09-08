import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AnrealMark } from "#/components/layout/anreal-brand";
import {
  ChatSession,
  parseMemoryMessages,
  type ChatUIMessage,
  type DeferredComposerSubmitInput,
} from "#/components/chat/chat-session";
import { ShareSessionProviders } from "#/components/share/share-session-providers";
import { useModels } from "#/hooks/use-models";
import { useWorkspaceSessionsContext } from "#/components/workspace/workspace-sessions-context";
import { finalizeInterruptedTools } from "#/lib/chat/finalize-interrupted-tools";
import { fetchPublicShare, forkShareSnapshot } from "#/lib/api";
import { queueShareForkDraft } from "#/lib/chat/queued-messages";
import { sessionNavigate } from "#/lib/workspace-urls";
import { getSessionUser } from "#/lib/auth-session";
import { applyWorkspaceTitle } from "#/lib/document-title";

/**
 * Shared snapshot banner rendered inside the normal thread scroll area so
 * the frozen copy keeps the exact chat-room layout (same max-width column,
 * same composer dock, same right rail when citations exist).
 */
export function ShareSnapshotBanner({
  title,
  ownerName,
  createdAt,
}: {
  title: string | null;
  ownerName: string | null;
  createdAt: string | null;
}) {
  return (
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
  );
}

export function useShareThreadData(shareToken: string): {
  status: "loading" | "ready" | "missing";
  title: string | null;
  ownerName: string | null;
  createdAt: string | null;
  messages: ChatUIMessage[] | null;
} {
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [title, setTitle] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatUIMessage[] | null>(null);

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
    })();
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  return { status, title, ownerName, createdAt, messages };
}

export function useShareAuth(): { signedIn: boolean; authChecked: boolean } {
  const [signedIn, setSignedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
  }, []);

  return { signedIn, authChecked };
}

export function ShareLoading(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 animate-fade-up">
      <AnrealMark className="opacity-80" />
      <div className="skeleton-shimmer h-4 w-40 rounded-full" />
      <p className="text-sm text-text-muted">Loading shared chat…</p>
    </div>
  );
}

type ShareRoomProps = {
  shareToken: string;
  title: string | null;
  ownerName: string | null;
  createdAt: string | null;
  messages: ChatUIMessage[];
};

function useShareTitle(title: string | null) {
  useEffect(() => {
    applyWorkspaceTitle(title?.trim() ? `${title.trim()} (shared)` : "Shared chat");
  }, [title]);
}

function ShareRoomShell({
  roomKey,
  children,
}: {
  roomKey: string;
  children: React.ReactNode;
}) {
  return (
    <ShareSessionProviders>
      <div key={roomKey} className="flex min-h-0 flex-1 flex-col animate-fade-up">
        {children}
      </div>
    </ShareSessionProviders>
  );
}

export function AnonymousShareRoom({ shareToken, title, ownerName, createdAt, messages }: ShareRoomProps) {
  const modelsState = useModels();
  const sessionsContext = useWorkspaceSessionsContext();
  useShareTitle(title);

  return (
    <ShareRoomShell roomKey={`share-anonymous:${shareToken}`}>
      <ChatSession
        sessionId={`share-${shareToken}`}
        projectId={null}
        initialMessages={messages}
        models={modelsState.models}
        reasoningEfforts={modelsState.reasoningEfforts}
        modelsStatus={modelsState.status}
        modelsError={modelsState.error}
        modelsRetry={modelsState.retry}
        onStreamSettled={() => {
          void sessionsContext.refreshQuiet();
        }}
        onAuthFailure={() => {}}
        onImageContextActions={sessionsContext.onImageContextActions}
        readOnly
        threadTopSlot={
          <ShareSnapshotBanner title={title} ownerName={ownerName} createdAt={createdAt} />
        }
        composerTopSlot={<AnonymousShareComposerCta shareToken={shareToken} />}
      />
    </ShareRoomShell>
  );
}

function AnonymousShareComposerCta({ shareToken }: { shareToken: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl bg-white/[0.04] px-4 py-4 text-center animate-fade-in">
      <p className="text-sm text-text">
        Log in or create an account to continue this chat as your own copy.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          href={`/login?redirect=${encodeURIComponent(`/share/${shareToken}`)}`}
          className="inline-flex min-h-10 cursor-pointer items-center rounded-full px-5 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98]"
        >
          Log in
        </a>
        <a
          href={`/register?redirect=${encodeURIComponent(`/share/${shareToken}`)}`}
          className="glass glass-interactive inline-flex min-h-10 cursor-pointer items-center rounded-full px-5 text-sm font-medium text-text transition active:scale-[0.98]"
        >
          Sign up
        </a>
      </div>
    </div>
  );
}

type ForkState =
  | { status: "idle" | "error"; sessionId: null; error: string | null }
  | { status: "forking"; sessionId: string | null; error: null };

/** Text-only provenance chip above the normal composer (no second textarea). */
function ShareForkNotice() {
  return (
    <p className="rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-text-muted">
      Your first send forks this snapshot into your own copy.
    </p>
  );
}

/**
 * Signed-in share room: the frozen thread renders with the normal composer
 * (model switcher, features, attach, queue) plus a text-only notice chip
 * above it. The first Send forks the snapshot server-side, navigates to the
 * viewer's own `/chat/<newId>` room (sidebar + normal chrome), and the same
 * draft auto-sends there through the standard pipeline — one gesture, smooth
 * handoff, AI reacts in place.
 */
export function AuthenticatedShareRoom({ shareToken, title, ownerName, createdAt, messages }: ShareRoomProps) {
  const modelsState = useModels();
  const sessionsContext = useWorkspaceSessionsContext();
  const navigate = useNavigate();
  const [fork, setFork] = useState<ForkState>({
    status: "idle",
    sessionId: null,
    error: null,
  });
  const [forkErrorVersion, setForkErrorVersion] = useState(0);
  const forkBusyRef = useRef(false);
  useShareTitle(title);

  const handleDeferredSubmit = useCallback(
    async (draft: DeferredComposerSubmitInput) => {
      if (forkBusyRef.current) return;
      forkBusyRef.current = true;
      setFork({ status: "forking", sessionId: null, error: null });
      try {
        const created = await forkShareSnapshot(shareToken);
        queueShareForkDraft(created.sessionId, {
          text: draft.text,
          attachments: draft.attachments,
          webSearchEnabled: draft.webSearchEnabled,
          deepResearchEnabled: draft.deepResearchEnabled,
          imageGenerationEnabled: draft.imageGenerationEnabled,
          imageGenSettings: { ...draft.imageGenSettings },
        });
        setFork({ status: "forking", sessionId: created.sessionId, error: null });
        // Client-side SPA navigation (typed pattern + params): the workspace
        // shell stays mounted, so the sidebar/topbar transition is smooth and
        // the forked room's auto-send starts the AI run immediately.
        await navigate({
          ...sessionNavigate({ sessionId: created.sessionId, projectId: null }),
        });
      } catch (error) {
        forkBusyRef.current = false;
        setFork({
          status: "error",
          sessionId: null,
          error: error instanceof Error ? error.message : "Could not start your copy",
        });
        setForkErrorVersion((version) => version + 1);
      }
    },
    [navigate, shareToken],
  );

  return (
    <ShareRoomShell roomKey={`share-signed-in:${shareToken}`}>
      <ChatSession
        sessionId={`share-${shareToken}`}
        projectId={null}
        initialMessages={messages}
        models={modelsState.models}
        reasoningEfforts={modelsState.reasoningEfforts}
        modelsStatus={modelsState.status}
        modelsError={modelsState.error}
        modelsRetry={modelsState.retry}
        onStreamSettled={() => {
          void sessionsContext.refreshQuiet();
        }}
        onAuthFailure={() => {}}
        onImageContextActions={sessionsContext.onImageContextActions}
        threadTopSlot={
          <ShareSnapshotBanner title={title} ownerName={ownerName} createdAt={createdAt} />
        }
        composerTopSlot={<ShareForkNotice />}
        deferredComposerLocked={fork.status === "forking"}
        deferredComposerError={
          fork.status === "error" && fork.error
            ? { version: forkErrorVersion, message: fork.error }
            : null
        }
        onDeferredComposerSubmit={handleDeferredSubmit}
      />
    </ShareRoomShell>
  );
}
