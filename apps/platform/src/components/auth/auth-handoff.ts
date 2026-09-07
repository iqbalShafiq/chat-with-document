export type AuthHandoffKind = "login" | "register";

export type AuthHandoffCopy = {
  title: string;
  detail: string;
};

export function isAuthRoutePath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/register";
}

export function authHandoffKind(pathname: string): AuthHandoffKind {
  return pathname === "/register" ? "register" : "login";
}

/**
 * The router updates `location` as soon as navigate() is called, while
 * `resolvedLocation` stays on the auth page until Home finishes loading.
 * That gap is when the form used to remount empty.
 */
export function isAuthHandoffPending(
  locationPathname: string,
  resolvedPathname: string,
): boolean {
  return (
    !isAuthRoutePath(locationPathname) && isAuthRoutePath(resolvedPathname)
  );
}

/** Path to keep painting while handing off (login ↔ register stays optimistic). */
export function authPaintedPathname(
  locationPathname: string,
  resolvedPathname: string,
): string {
  if (isAuthRoutePath(locationPathname)) return locationPathname;
  if (isAuthRoutePath(resolvedPathname)) return resolvedPathname;
  return "/login";
}

export function authHandoffCopy(kind: AuthHandoffKind): AuthHandoffCopy {
  if (kind === "register") {
    return {
      title: "Account created",
      detail: "Opening your workspace",
    };
  }
  return {
    title: "You're in",
    detail: "Opening your workspace",
  };
}
