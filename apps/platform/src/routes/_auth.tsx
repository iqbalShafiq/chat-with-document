import { createFileRoute } from "@tanstack/react-router";
import { AuthShell } from "#/components/auth/auth-shell";

/**
 * Pathless layout: keeps auth chrome mounted across /login ↔ /register
 * so only the form column crossfades.
 */
export const Route = createFileRoute("/_auth")({
  component: AuthShell,
});
