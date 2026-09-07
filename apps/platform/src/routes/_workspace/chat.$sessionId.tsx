import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { ChatRouteView } from "#/components/workspace/chat-route-view";
import { sessionNavigate } from "#/lib/workspace-urls";

/** Standalone chat room: `/chat/$sessionId` (projectId must be null). */
export const Route = createFileRoute("/_workspace/chat/$sessionId")({
  component: StandaloneChatRoute,
});

function StandaloneChatRoute() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();

  const handleAuthFailure = useCallback(() => {
    void navigate({
      to: "/login",
      search: { redirect: window.location.pathname + window.location.search },
      viewTransition: true,
    });
  }, [navigate]);

  const handleCanonicalSession = useCallback(
    (nextSessionId: string, projectId: string | null) => {
      void navigate({
        ...sessionNavigate({ sessionId: nextSessionId, projectId }),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <ChatRouteView
      sessionId={sessionId}
      projectId={null}
      onAuthFailure={handleAuthFailure}
      onCanonicalSession={handleCanonicalSession}
    />
  );
}
