import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { ChatRouteView } from "#/components/workspace/chat-route-view";
import { sessionNavigate } from "#/lib/workspace-urls";

/** Project chat room: `/projects/$projectId/chat/$sessionId`. */
export const Route = createFileRoute(
  "/_workspace/projects/$projectId/chat/$sessionId",
)({
  component: ProjectChatRoute,
});

function ProjectChatRoute() {
  const { projectId, sessionId } = Route.useParams();
  const navigate = useNavigate();

  const handleAuthFailure = useCallback(() => {
    void navigate({
      to: "/login",
      search: { redirect: window.location.pathname + window.location.search },
      viewTransition: true,
    });
  }, [navigate]);

  const handleCanonicalSession = useCallback(
    (nextSessionId: string, nextProjectId: string | null) => {
      void navigate({
        ...sessionNavigate({ sessionId: nextSessionId, projectId: nextProjectId }),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <ChatRouteView
      sessionId={sessionId}
      projectId={projectId}
      onAuthFailure={handleAuthFailure}
      onCanonicalSession={handleCanonicalSession}
    />
  );
}
