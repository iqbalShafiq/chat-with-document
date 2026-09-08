/**
 * Canonical workspace URLs (single source of truth for deep links).
 *
 * Two complementary shapes:
 * - `*Url` string builders for hrefs, tests, and E2E (also used by the
 *   router-history fallback in `navigateToHref`).
 * - `*Navigate` typed pattern + params for `navigate` / `redirect` /
 *   `Link`, which keeps navigation client-side with a real history entry.
 */

/**
 * Typed TanStack `navigate` / `redirect` / `Link` targets.
 * Always pass the path pattern + params — interpolating ids into `to`
 * causes a document navigation and empties the browser history stack.
 */
export type SessionNavigateTarget =
  | { to: "/chat/$sessionId"; params: { sessionId: string } }
  | {
      to: "/projects/$projectId/chat/$sessionId";
      params: { projectId: string; sessionId: string };
    };

export function sessionNavigate(input: {
  sessionId: string;
  projectId: string | null;
}): SessionNavigateTarget {
  if (input.projectId) {
    return {
      to: "/projects/$projectId/chat/$sessionId",
      params: { projectId: input.projectId, sessionId: input.sessionId },
    };
  }
  return {
    to: "/chat/$sessionId",
    params: { sessionId: input.sessionId },
  };
}

export function projectNavigate(projectId: string): {
  to: "/projects/$projectId";
  params: { projectId: string };
} {
  return { to: "/projects/$projectId", params: { projectId } };
}

export function chatUrl(sessionId: string): string {
  return `/chat/${encodeURIComponent(sessionId)}`;
}



export function projectUrl(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function projectChatUrl(projectId: string, sessionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}`;
}

export function documentsUrl(): string {
  return "/documents";
}

/** Resolve the canonical URL for a session given its project membership. */
export function sessionUrl(input: {
  sessionId: string;
  projectId: string | null;
}): string {
  return input.projectId
    ? projectChatUrl(input.projectId, input.sessionId)
    : chatUrl(input.sessionId);
}

/**
 * Parse a pathname back into a workspace target. Returns null when the
 * pathname is not a session/project URL (e.g. /login, /documents).
 */
export function parseWorkspacePath(pathname: string): {
  projectId: string | null;
  sessionId: string | null;
} | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "chat" && segments[1]) {
    return {
      projectId: null,
      sessionId: decodeURIComponent(segments[1]!),
    };
  }
  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[1] &&
    segments[2] === "chat" &&
    segments[3]
  ) {
    return {
      projectId: decodeURIComponent(segments[1]!),
      sessionId: decodeURIComponent(segments[3]!),
    };
  }
  return null;
}
