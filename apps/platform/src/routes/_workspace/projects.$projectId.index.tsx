import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";

import { AnrealMark } from "#/components/layout/anreal-brand";
import { ProjectNotFound } from "#/components/workspace/workspace-not-found";
import {
  getOrCreateEmptyChatSession,
  getProject,
  listSessions,
} from "#/lib/api";
import { findEmptyNewChat } from "#/lib/session-history";
import { sessionNavigate } from "#/lib/workspace-urls";

/**
 * Project root: `/projects/$projectId` resolves the project's chat target
 * (existing empty draft, most recent chat, or a fresh server draft) and
 * replaces the entry with `/projects/$projectId/chat/$sessionId`.
 */
export const Route = createFileRoute("/_workspace/projects/$projectId/")({
  beforeLoad: async ({ params }) => {
    try {
      await getProject(params.projectId);
    } catch {
      return { projectMissing: true as const };
    }
    try {
      const page = await listSessions({
        limit: 30,
        projectId: params.projectId,
      });
      const empty = findEmptyNewChat(page.items);
      const pick = empty ?? page.items[0] ?? null;
      if (pick) {
        throw redirect({
          ...sessionNavigate({
            sessionId: pick.sessionId,
            projectId: params.projectId,
          }),
          replace: true,
        });
      }
    } catch (error) {
      if (isRedirect(error)) throw error;
    }
    const draft = await getOrCreateEmptyChatSession({
      projectId: params.projectId,
    });
    throw redirect({
      ...sessionNavigate({
        sessionId: draft.sessionId,
        projectId: params.projectId,
      }),
      replace: true,
    });
  },
  component: ProjectRootRoute,
});

function ProjectRootRoute() {
  const data = Route.useLoaderData() as { projectMissing?: boolean };
  if (data?.projectMissing) {
    return <ProjectNotFound />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 animate-fade-up">
      <AnrealMark className="opacity-80" />
      <div className="skeleton-shimmer h-4 w-40 rounded-full" />
      <p className="text-sm text-text-muted">Opening project…</p>
    </div>
  );
}
