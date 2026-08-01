import { createAuthClient } from "better-auth/react";
import { API_BASE } from "#/lib/api";

export const authClient = createAuthClient({
  baseURL: API_BASE,
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

export function userInitials(user: Pick<SessionUser, "name" | "email">): string {
  const name = user.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  const email = user.email?.trim() ?? "?";
  return email.slice(0, 2).toUpperCase();
}
