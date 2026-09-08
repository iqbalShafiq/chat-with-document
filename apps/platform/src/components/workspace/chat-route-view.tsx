import { useEffect, useState } from "react";

import { ChatSession, parseMemoryMessages, type ChatUIMessage } from "#/components/chat/chat-session";
import { AnrealMark } from "#/components/layout/anreal-brand";
import { SessionNotFound } from "#/components/workspace/workspace-not-found";
import { useWorkspaceSessionsContext } from "#/components/workspace/workspace-sessions-context";
import { useModels } from "#/hooks/use-models";
import { finalizeInterruptedTools } from "#/lib/chat/finalize-interrupted-tools";
import { consumeShareForkDraft } from "#/lib/chat/queued-messages";
import {
  ApiAuthError,
  listSessions,
  loadChatMessages,
} from "#/lib/api";

export function useChatRouteData(input: {
  sessionId: string;
  projectId: string | null;
  onAuthFailure: () => void;
  onCanonicalSession: (sessionId: string, projectId: string | null) => void;
}): {
  status: "loading" | "ready" | "missing";
  messages: ChatUIMessage[] | null;
  setMessages: (messages: ChatUIMessage[]) => void;
} {
  const { sessionId, projectId, onAuthFailure, onCanonicalSession } = input;
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [messages, setMessages] = useState<ChatUIMessage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMessages(null);
    void (async () => {
      try {
        if (projectId) {
          const standalone = await listSessions({ limit: 100 }).catch(() => null);
          if (cancelled) return;
          const cross = standalone?.items.find(
            (s) => s.sessionId === sessionId,
          );
          if (cross) {
            onCanonicalSession(cross.sessionId, null);
            return;
          }
        }
        // History load is authoritative for unknown ids: missing rows
        // yield an empty array, so verify membership before rendering.
        // Fork sessions seed memory directly, therefore they appear in
        // the list; an id absent from the list with empty history is gone.
        const [data, scoped] = await Promise.all([
          loadChatMessages(sessionId),
          listSessions({ limit: 100, projectId: projectId ?? undefined }).catch(
            () => null,
          ),
        ]);
        if (cancelled) return;
        const messages = finalizeInterruptedTools(parseMemoryMessages(data));
        const known = scoped?.items.some((s) => s.sessionId === sessionId);
        if (messages.length === 0 && !known) {
          setStatus("missing");
          return;
        }
        setMessages(messages);
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiAuthError) {
          onAuthFailure();
          return;
        }
        console.error("[chat-route] failed to load conversation", error);
        setStatus("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onAuthFailure, onCanonicalSession, projectId, sessionId]);

  return {
    status,
    messages,
    setMessages: (next: ChatUIMessage[]) => setMessages(next),
  };
}

export function ChatRouteView(input: {
  sessionId: string;
  projectId: string | null;
  onAuthFailure: () => void;
  onCanonicalSession: (sessionId: string, projectId: string | null) => void;
}): React.JSX.Element {
  const modelsState = useModels();
  const sessionsContext = useWorkspaceSessionsContext();
  const route = useChatRouteData(input);
  // One-shot share-fork handoff: consumed once on mount so refresh/back
  // never re-sends the same first message.
  const [shareForkHandoff] = useState(() => consumeShareForkDraft(input.sessionId));

  if (route.status === "missing") {
    return <SessionNotFound projectId={input.projectId} />;
  }
  if (route.status === "loading" || route.messages === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 animate-fade-up">
        <AnrealMark className="opacity-80" />
        <div className="skeleton-shimmer h-4 w-40 rounded-full" />
        <p className="text-sm text-text-muted">Loading conversation…</p>
      </div>
    );
  }
  return (
    <div
      key={`chat-shell-${input.projectId ?? "standalone"}:${input.sessionId}`}
      className="flex min-h-0 flex-1 flex-col animate-fade-up"
    >
      <ChatSession
        sessionId={input.sessionId}
        projectId={input.projectId}
        initialMessages={route.messages}
        models={modelsState.models}
        reasoningEfforts={modelsState.reasoningEfforts}
        modelsStatus={modelsState.status}
        modelsError={modelsState.error}
        modelsRetry={modelsState.retry}
        onStreamSettled={() => {
          void sessionsContext.refreshQuiet();
        }}
        onAuthFailure={input.onAuthFailure}
        onImageContextActions={sessionsContext.onImageContextActions}
        onReloadMessages={(messages) => route.setMessages(messages)}
        initialComposerDraft={
          shareForkHandoff
            ? { text: shareForkHandoff.text, attachments: shareForkHandoff.attachments }
            : null
        }
        initialFeatureFlags={
          shareForkHandoff
            ? {
                webSearchEnabled: shareForkHandoff.webSearchEnabled,
                deepResearchEnabled: shareForkHandoff.deepResearchEnabled,
                imageGenerationEnabled: shareForkHandoff.imageGenerationEnabled,
                imageGenSettings: shareForkHandoff.imageGenSettings,
              }
            : null
        }
      />
    </div>
  );
}
