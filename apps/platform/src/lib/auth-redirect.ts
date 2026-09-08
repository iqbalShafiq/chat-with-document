/** Safe post-auth return navigation (prevents open redirects). */

export function isSafeRedirect(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
  );
}

export function parseRedirectSearch(
  search: Record<string, unknown>,
): { redirect: string | undefined } {
  return {
    redirect: isSafeRedirect(search.redirect) ? search.redirect : undefined,
  };
}

/**
 * Navigate to a validated in-app href after sign-in/sign-up, where the
 * target is a dynamic deep link (`/chat/$sessionId`, ...) that cannot be
 * expressed as a static `navigate({ to })` path.
 */
export function navigateToHref(
  router: {
    navigate: (options: { to: string }) => void;
  },
  href: string,
): void {
  router.navigate({ to: href });
}
