import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";

import {
  getOrCreateEmptyChatSession,
  listSessions,
} from "#/lib/api";
import { readLastStandaloneSessionId } from "#/lib/session-storage";
import { findEmptyNewChat } from "#/lib/session-history";
import { sessionNavigate } from "#/lib/workspace-urls";

/**
 * New-chat entry: `/` never renders a chat room. It resolves the standalone
 * target (remembered chat, visible empty draft, or a fresh server draft) and
 * replaces the history entry with the canonical `/chat/$sessionId` URL.
 */
export const Route = createFileRoute("/_workspace/")({
  beforeLoad: async () => {
    const remembered = readLastStandaloneSessionId();
    if (remembered) {
      try {
        const page = await listSessions({ limit: 30 });
        if (page.items.some((s) => s.sessionId === remembered)) {
          throw redirect({
            ...sessionNavigate({ sessionId: remembered, projectId: null }),
            replace: true,
          });
        }
      } catch (error) {
        if (isRedirect(error)) throw error;
        // Fall through to draft resolution on transient failures.
      }
    }
    try {
      const page = await listSessions({ limit: 30 });
      const empty = findEmptyNewChat(page.items);
      const pick = empty ?? page.items[0] ?? null;
      if (pick) {
        throw redirect({
          ...sessionNavigate({ sessionId: pick.sessionId, projectId: null }),
          replace: true,
        });
      }
    } catch (error) {
      if (isRedirect(error)) throw error;
    }
    const draft = await getOrCreateEmptyChatSession({ projectId: null });
    throw redirect({
      ...sessionNavigate({ sessionId: draft.sessionId, projectId: null }),
      replace: true,
    });
  },
  component: RootRedirect,
});

function RootRedirect() {
  return null;
}
