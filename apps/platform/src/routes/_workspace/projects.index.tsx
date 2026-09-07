import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { ProjectsBrowser } from "#/components/projects/projects-browser";
import type { ProjectListItem } from "#/lib/api";
import { persistLastStandaloneSessionId } from "#/lib/session-storage";
import { projectNavigate } from "#/lib/workspace-urls";

/** Projects browser: `/projects`. */
export const Route = createFileRoute("/_workspace/projects/")({
  component: ProjectsIndexRoute,
});

function ProjectsIndexRoute() {
  const navigate = useNavigate();

  const handleProjectDeleted = useCallback(() => {
    // Recent-projects in the sidebar refresh on next mount; nothing else to
    // do — the browser stays on `/projects` after a delete.
  }, []);

  const handleOpenProject = useCallback(
    (project: ProjectListItem) => {
      try {
        const stored = window.localStorage.getItem("chat.sessionId");
        if (stored?.trim()) {
          persistLastStandaloneSessionId(stored.trim());
        }
      } catch {
        // Best-effort only; the `/` redirector recovers without it.
      }
      void navigate(projectNavigate(project.id));
    },
    [navigate],
  );

  return (
    <ProjectsBrowser
      key="workspace-projects"
      onOpenProject={handleOpenProject}
      onProjectDeleted={handleProjectDeleted}
    />
  );
}
