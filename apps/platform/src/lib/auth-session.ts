import { authClient, type SessionUser } from "#/lib/auth-client";
import { clearSessionOnAuth } from "#/lib/session-storage";

type AuthUserLike = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

/** In-memory user from the sign-in/up response, consumed once by Home. */
let workspaceHandoffUser: SessionUser | null = null;

export function toSessionUser(user: AuthUserLike): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
  };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await authClient.getSession();
  const user = session.data?.user;
  if (!user) return null;
  return toSessionUser(user);
}

export function rememberWorkspaceUser(user: SessionUser): void {
  workspaceHandoffUser = user;
}

/** Returns the remembered user at most once so a later getSession still runs. */
export function consumeWorkspaceUser(): SessionUser | null {
  const user = workspaceHandoffUser;
  workspaceHandoffUser = null;
  return user;
}

/**
 * After a successful sign-in/up: stash the user so Home can skip a second
 * getSession, and drop client-invented session ids before the workspace opens.
 */
export function beginWorkspaceHandoff(user: SessionUser): void {
  rememberWorkspaceUser(user);
  clearSessionOnAuth();
}
