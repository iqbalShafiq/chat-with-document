import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { WorkspaceShell } from "#/components/workspace/workspace-shell";
import { consumeWorkspaceUser, getSessionUser } from "#/lib/auth-session";

/**
 * Authenticated workspace layout: owns the gate, the sidebar shell, and the
 * shared session list. Child routes (chat / projects / documents) render in
 * the outlet so the shell never remounts when switching conversations.
 */
export const Route = createFileRoute("/_workspace")({
  beforeLoad: async ({ location }) => {
    const user = consumeWorkspaceUser() ?? (await getSessionUser());
    if (!user) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
        viewTransition: true,
      });
    }
    return { user };
  },
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { user } = Route.useRouteContext();
  return (
    <WorkspaceShell user={user}>
      <Outlet />
    </WorkspaceShell>
  );
}
